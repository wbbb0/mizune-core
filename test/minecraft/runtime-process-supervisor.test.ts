import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { RuntimeResourceRegistry } from "../../src/runtime/resources/runtimeResourceRegistry.ts";
import { RuntimeResourceStore } from "../../src/runtime/resources/runtimeResourceStore.ts";
import { MinecraftActorJournal } from "../../src/services/minecraft/actorJournal.ts";
import { MinecraftActorProvisioningService } from "../../src/services/minecraft/actorProvisioningService.ts";
import { MinecraftActorProvisioningStore } from "../../src/services/minecraft/actorProvisioningStore.ts";
import { matchesLinuxProcessIdentity, readCurrentBootId } from "../../src/services/minecraft/processIdentity.ts";
import { MinecraftRuntimeTemplateCatalog } from "../../src/services/minecraft/runtimeTemplateCatalog.ts";
import { MinecraftRuntimeProcessSupervisor } from "../../src/services/minecraft/runtimeProcessSupervisor.ts";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

test("父项目按自然委派启动 simulation daemon，并以进程指纹安全停止", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "minecraft-runtime-supervisor-"));
  const runtimeDir = join(dataDir, "run");
  const database = new StateDatabase(dataDir, createSilentLogger());
  const registry = new RuntimeResourceRegistry(new RuntimeResourceStore(database));
  const journal = new MinecraftActorJournal();
  const provisioningStore = new MinecraftActorProvisioningStore(database, journal);
  const config = createTestAppConfig({
    minecraft: {
      enabled: true,
      runtimeDir,
      supervisor: {
        pythonExecutable: "python3",
        pythonModulePath: join(PROJECT_ROOT, "vendor/mizune-mc-runtime/src"),
        startupTimeoutMs: 5_000,
        stopGraceMs: 1_000
      },
      templates: {
        simulation: {
          backend: "simulation",
          minecraftVersion: "1.21.1",
          loader: "vanilla",
          gameProfileId: "simulation-profile",
          identityRef: "simulation-identity",
          allowedServers: ["127.0.0.1:25566"],
          modelRefs: ["test-model"]
        }
      }
    }
  });
  const templates = new MinecraftRuntimeTemplateCatalog(config);
  const delegate = new MinecraftActorProvisioningService(
    templates,
    provisioningStore,
    registry,
    runtimeDir
  );
  const supervisor = new MinecraftRuntimeProcessSupervisor(
    config,
    registry,
    provisioningStore,
    templates,
    createSilentLogger()
  );
  let daemonIdentity: { pid: number; startTicks: string; bootId: string } | null = null;
  try {
    const delegated = await delegate.delegate({
      serverAddress: "127.0.0.1:25566",
      instruction: "进去看看周围有什么",
      ownerSessionId: "web:owner",
      ownerPrincipalId: "owner",
      idempotencyKey: "supervisor-delegate"
    });
    const resourceId = delegated.resource.resourceId;
    await supervisor.start();
    await waitUntil(async () => (
      (await registry.get(resourceId))?.minecraftActor?.binding.provisionStatus === "ready"
    ), 7_000);

    const incarnation = await provisioningStore.getActiveIncarnation(resourceId);
    assert.ok(incarnation?.daemonPid && incarnation.daemonStartTicks && incarnation.processGroupId);
    daemonIdentity = {
      pid: incarnation.daemonPid,
      startTicks: incarnation.daemonStartTicks,
      bootId: incarnation.bootId
    };
    assert.equal(await matchesLinuxProcessIdentity(daemonIdentity), true);
    assert.equal((await stat(incarnation.tokenFile)).mode & 0o777, 0o600);
    assert.equal((await stat(join(runtimeDir, resourceId))).mode & 0o777, 0o700);
    const token = await readFile(incarnation.tokenFile, "utf8");
    const commandLine = (await readFile(`/proc/${incarnation.daemonPid}/cmdline`, "utf8")).replaceAll("\0", " ");
    assert.doesNotMatch(commandLine, new RegExp(escapeRegExp(token), "u"));

    process.kill(-daemonIdentity.pid, "SIGKILL");
    await waitUntil(async () => (
      (await registry.get(resourceId))?.minecraftActor?.binding.provisionStatus === "retry_wait"
    ), 3_000);
    assert.equal(await matchesLinuxProcessIdentity(daemonIdentity), false);
    const retryAtMs = (await registry.get(resourceId))?.minecraftActor?.binding.retryAtMs;
    assert.ok(retryAtMs);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, retryAtMs - Date.now()) + 10));
    await supervisor.reconcile();
    await waitUntil(async () => (
      (await registry.get(resourceId))?.minecraftActor?.binding.provisionStatus === "ready"
    ), 7_000);
    const restarted = await provisioningStore.getActiveIncarnation(resourceId);
    assert.ok(restarted?.daemonPid && restarted.daemonStartTicks);
    assert.notEqual(restarted.daemonPid, daemonIdentity.pid);
    daemonIdentity = {
      pid: restarted.daemonPid,
      startTicks: restarted.daemonStartTicks,
      bootId: restarted.bootId
    };

    await supervisor.stop();
    assert.equal(await matchesLinuxProcessIdentity(daemonIdentity), false);
    assert.equal(
      (await registry.get(resourceId))?.minecraftActor?.binding.provisionStatus,
      "stopped"
    );
    await assert.rejects(access(restarted.socketPath));
  } finally {
    await supervisor.stop().catch(() => undefined);
    if (daemonIdentity && await matchesLinuxProcessIdentity(daemonIdentity)) {
      try { process.kill(-daemonIdentity.pid, "SIGKILL"); } catch { /* test cleanup */ }
    }
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("父进程在 spawn 后、SQLite 登记前退出时可通过 daemon 自登记恢复", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "minecraft-runtime-orphan-recovery-"));
  const runtimeDir = join(dataDir, "run");
  const database = new StateDatabase(dataDir, createSilentLogger());
  const registry = new RuntimeResourceRegistry(new RuntimeResourceStore(database));
  const provisioningStore = new MinecraftActorProvisioningStore(database, new MinecraftActorJournal());
  const config = createTestAppConfig({
    minecraft: {
      enabled: true,
      runtimeDir,
      supervisor: {
        pythonExecutable: "python3",
        pythonModulePath: join(PROJECT_ROOT, "vendor/mizune-mc-runtime/src"),
        startupTimeoutMs: 3_000,
        stopGraceMs: 1_000
      },
      templates: {
        simulation: {
          backend: "simulation",
          minecraftVersion: "1.21.1",
          loader: "vanilla",
          gameProfileId: "simulation-profile",
          identityRef: "simulation-identity",
          allowedServers: ["127.0.0.1:25566"],
          modelRefs: ["test-model"]
        }
      }
    }
  });
  const templates = new MinecraftRuntimeTemplateCatalog(config);
  const delegated = await new MinecraftActorProvisioningService(
    templates, provisioningStore, registry, runtimeDir
  ).delegate({
    serverAddress: "127.0.0.1:25566",
    instruction: "恢复后继续观察",
    ownerSessionId: "web:owner",
    ownerPrincipalId: "owner",
    idempotencyKey: "orphan-recovery"
  });
  const resourceId = delegated.resource.resourceId;
  const actorId = delegated.resource.minecraftActor!.actorId;
  const resourceDir = join(runtimeDir, resourceId);
  const socketPath = join(resourceDir, "runtime.sock");
  const databasePath = join(resourceDir, "runtime.sqlite");
  const tokenFile = join(resourceDir, "auth.token");
  const pidFile = join(resourceDir, "runtime.pid.json");
  const gameDirectory = join(resourceDir, "game");
  const attemptId = "attempt-crash-window";
  const runtimeInstanceId = "runtime-crash-window";
  await mkdir(gameDirectory, { recursive: true, mode: 0o700 });
  await writeFile(tokenFile, "test-token", { mode: 0o600 });
  await provisioningStore.beginAttempt({
    resourceId,
    attemptId,
    runtimeInstanceId,
    socketPath,
    gameDirectory,
    tokenFile,
    bootId: await readCurrentBootId(),
    nowMs: Date.now()
  });
  const daemon = spawn("python3", [
    "-m", "mizune_mc_runtime.daemon",
    "--socket", socketPath,
    "--database", databasePath,
    "--actor-id", actorId,
    "--runtime-instance-id", runtimeInstanceId,
    "--pid-file", pidFile,
    "--auth-token-file", tokenFile
  ], {
    cwd: PROJECT_ROOT,
    detached: true,
    env: {
      PATH: process.env.PATH,
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: join(PROJECT_ROOT, "vendor/mizune-mc-runtime/src")
    },
    stdio: "ignore"
  });
  assert.ok(daemon.pid);
  daemon.unref();
  const supervisor = new MinecraftRuntimeProcessSupervisor(
    config, registry, provisioningStore, templates, createSilentLogger()
  );
  try {
    await waitUntil(async () => {
      try { await access(pidFile); return true; } catch { return false; }
    }, 2_000);
    assert.equal((await provisioningStore.getActiveIncarnation(resourceId))?.daemonPid, null);
    await supervisor.start();
    await waitUntil(async () => (
      (await registry.get(resourceId))?.minecraftActor?.binding.provisionStatus === "ready"
    ), 5_000);
    const recovered = await provisioningStore.getActiveIncarnation(resourceId);
    assert.equal(recovered?.runtimeInstanceId, runtimeInstanceId);
    assert.equal(recovered?.daemonPid, daemon.pid);
    await supervisor.stop();
    assert.equal(await matchesLinuxProcessIdentity({
      pid: recovered!.daemonPid!,
      startTicks: recovered!.daemonStartTicks!,
      bootId: recovered!.bootId
    }), false);
  } finally {
    await supervisor.stop().catch(() => undefined);
    if (daemon.pid) {
      try { process.kill(-daemon.pid, "SIGKILL"); } catch { /* test cleanup */ }
    }
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

for (const [label, pythonExecutable] of [
  ["不存在的 executable", "/definitely/missing/mizune-python"],
  ["立即退出的 executable", "/bin/true"]
] as const) {
  test(`supervisor 安全收敛${label}`, async () => {
    const harness = await createSupervisorHarness(`spawn-failure-${pythonExecutable.split("/").pop()}`, pythonExecutable);
    try {
      await harness.supervisor.start();
      await waitUntil(async () => {
        const status = (await harness.registry.get(harness.resourceId))?.minecraftActor?.binding.provisionStatus;
        return status === "retry_wait" || status === "failed";
      }, 3_000);
      assert.equal(await harness.provisioningStore.getActiveIncarnation(harness.resourceId), null);
    } finally {
      await harness.close();
    }
  });
}

test("资源在 SQLite PID 登记前关闭也会回收 daemon 自登记孤儿", async () => {
  const harness = await createOrphanHarness("closed-orphan");
  try {
    await harness.registry.markStatus(harness.resourceId, "closed", Date.now());
    await harness.supervisor.start();
    await waitUntil(async () => (
      !(await matchesLinuxProcessIdentity(harness.identity))
      && (await harness.provisioningStore.getActiveIncarnation(harness.resourceId)) === null
    ), 4_000);
    assert.equal(await harness.provisioningStore.getActiveIncarnation(harness.resourceId), null);
  } finally {
    await harness.close();
  }
});

test("supervisor shutdown 会回收 SQLite PID 登记前的 daemon 自登记孤儿", async () => {
  const harness = await createOrphanHarness("shutdown-orphan");
  try {
    const firstStop = harness.supervisor.stop();
    assert.equal(harness.supervisor.stop(), firstStop);
    await firstStop;
    assert.equal(await matchesLinuxProcessIdentity(harness.identity), false);
    assert.equal(await harness.provisioningStore.getActiveIncarnation(harness.resourceId), null);
  } finally {
    await harness.close();
  }
});

test("模板或 allowlist 撤权进入 needs_attention 后会终止旧 Runtime", async () => {
  const harness = await createSupervisorHarness("policy-revoked", "python3");
  try {
    await harness.supervisor.start();
    await waitUntil(async () => (
      (await harness.registry.get(harness.resourceId))?.minecraftActor?.binding.provisionStatus === "ready"
    ), 5_000);
    const incarnation = await harness.provisioningStore.getActiveIncarnation(harness.resourceId);
    assert.ok(incarnation?.daemonPid && incarnation.daemonStartTicks);
    const identity = {
      pid: incarnation.daemonPid,
      startTicks: incarnation.daemonStartTicks,
      bootId: incarnation.bootId
    };
    await harness.provisioningStore.markNeedsAttention({
      resourceId: harness.resourceId,
      failureCode: "server_not_allowed",
      failureMessage: "目标服务器已从 allowlist 撤销",
      phase: "resolving_template",
      nowMs: Date.now()
    });
    await harness.supervisor.reconcile();
    await waitUntil(async () => (
      !(await matchesLinuxProcessIdentity(identity))
      && (await harness.provisioningStore.getActiveIncarnation(harness.resourceId)) === null
    ), 4_000);
    assert.equal(
      (await harness.registry.get(harness.resourceId))?.minecraftActor?.binding.provisionStatus,
      "needs_attention"
    );
  } finally {
    await harness.close();
  }
});

async function createSupervisorHarness(label: string, pythonExecutable: string) {
  const dataDir = await mkdtemp(join(tmpdir(), `minecraft-runtime-${label}-`));
  const runtimeDir = join(dataDir, "run");
  const database = new StateDatabase(dataDir, createSilentLogger());
  const registry = new RuntimeResourceRegistry(new RuntimeResourceStore(database));
  const provisioningStore = new MinecraftActorProvisioningStore(database, new MinecraftActorJournal());
  const config = createTestAppConfig({
    minecraft: {
      enabled: true,
      runtimeDir,
      supervisor: {
        pythonExecutable,
        pythonModulePath: join(PROJECT_ROOT, "vendor/mizune-mc-runtime/src"),
        startupTimeoutMs: 1_000,
        stopGraceMs: 500
      },
      templates: {
        simulation: {
          backend: "simulation",
          minecraftVersion: "1.21.1",
          loader: "vanilla",
          gameProfileId: "simulation-profile",
          identityRef: "simulation-identity",
          allowedServers: ["127.0.0.1:25566"],
          modelRefs: ["test-model"]
        }
      }
    }
  });
  const templates = new MinecraftRuntimeTemplateCatalog(config);
  const delegated = await new MinecraftActorProvisioningService(
    templates, provisioningStore, registry, runtimeDir
  ).delegate({
    serverAddress: "127.0.0.1:25566",
    instruction: "进去看看周围",
    ownerSessionId: "web:owner",
    ownerPrincipalId: "owner",
    idempotencyKey: `supervisor-${label}`
  });
  const supervisor = new MinecraftRuntimeProcessSupervisor(
    config, registry, provisioningStore, templates, createSilentLogger()
  );
  return {
    dataDir,
    database,
    registry,
    provisioningStore,
    supervisor,
    resourceId: delegated.resource.resourceId,
    async close() {
      await supervisor.stop().catch(() => undefined);
      database.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

async function createOrphanHarness(label: string) {
  const harness = await createSupervisorHarness(label, "python3");
  const resource = await harness.registry.get(harness.resourceId);
  const actorId = resource?.minecraftActor?.actorId;
  assert.ok(actorId);
  const resourceDir = join(harness.dataDir, "run", harness.resourceId);
  const gameDirectory = join(resourceDir, "game");
  const socketPath = join(resourceDir, "runtime.sock");
  const databasePath = join(resourceDir, "runtime.sqlite");
  const tokenFile = join(resourceDir, "auth.token");
  const pidFile = join(resourceDir, "runtime.pid.json");
  const attemptId = `attempt-${label}`;
  const runtimeInstanceId = `runtime-${label}`;
  await mkdir(gameDirectory, { recursive: true, mode: 0o700 });
  await writeFile(tokenFile, "test-token", { mode: 0o600 });
  await harness.provisioningStore.beginAttempt({
    resourceId: harness.resourceId,
    attemptId,
    runtimeInstanceId,
    socketPath,
    gameDirectory,
    tokenFile,
    bootId: await readCurrentBootId(),
    nowMs: Date.now()
  });
  const daemon = spawn("python3", [
    "-m", "mizune_mc_runtime.daemon",
    "--socket", socketPath,
    "--database", databasePath,
    "--actor-id", actorId,
    "--runtime-instance-id", runtimeInstanceId,
    "--pid-file", pidFile,
    "--auth-token-file", tokenFile
  ], {
    cwd: PROJECT_ROOT,
    detached: true,
    env: {
      PATH: process.env.PATH,
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: join(PROJECT_ROOT, "vendor/mizune-mc-runtime/src")
    },
    stdio: "ignore"
  });
  assert.ok(daemon.pid);
  daemon.unref();
  await waitUntil(async () => {
    try { await access(pidFile); return true; } catch { return false; }
  }, 2_000);
  const registration = JSON.parse(await readFile(pidFile, "utf8")) as {
    pid: number;
    startTicks: string;
    bootId: string;
  };
  assert.equal(registration.pid, daemon.pid);
  return {
    ...harness,
    identity: registration,
    async close() {
      await harness.close();
      if (await matchesLinuxProcessIdentity(registration)) {
        try { process.kill(-registration.pid, "SIGKILL"); } catch { /* test cleanup */ }
      }
    }
  };
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("等待 Runtime supervisor 状态超时");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
