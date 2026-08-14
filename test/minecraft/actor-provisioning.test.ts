import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { openMinecraftActorStream } from "../../src/internalApi/application/minecraftActorAdminService.ts";
import type { InternalApiMinecraftActorDeps } from "../../src/internalApi/types.ts";
import { RuntimeResourceRegistry } from "../../src/runtime/resources/runtimeResourceRegistry.ts";
import { RuntimeResourceStore } from "../../src/runtime/resources/runtimeResourceStore.ts";
import { MinecraftActorControlStore } from "../../src/services/minecraft/actorControlStore.ts";
import { MinecraftActorJournal } from "../../src/services/minecraft/actorJournal.ts";
import { MinecraftActorProvisioningService } from "../../src/services/minecraft/actorProvisioningService.ts";
import { MinecraftActorProvisioningStore } from "../../src/services/minecraft/actorProvisioningStore.ts";
import { MinecraftRuntimeTemplateCatalog } from "../../src/services/minecraft/runtimeTemplateCatalog.ts";
import { parseMinecraftServerAddress } from "../../src/services/minecraft/serverTarget.ts";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("服务器地址严格规范化并拒绝 URL、歧义 IPv6 和非法端口", () => {
  assert.deepEqual(parseMinecraftServerAddress("MC.Example.COM."), {
    host: "mc.example.com",
    port: 25565,
    address: "mc.example.com:25565",
    key: "mc.example.com:25565"
  });
  assert.equal(parseMinecraftServerAddress("[::1]:25566").address, "[::1]:25566");
  assert.throws(() => parseMinecraftServerAddress("https://mc.example.com"), /不能是 URL/u);
  assert.throws(() => parseMinecraftServerAddress("::1:25566"), /必须使用/u);
  assert.throws(() => parseMinecraftServerAddress("localhost:65536"), /1 到 65535/u);
  assert.throws(() => parseMinecraftServerAddress("localhost:"), /端口无效/u);
  assert.throws(() => parseMinecraftServerAddress("[::1]:"), /端口无效/u);
  assert.throws(() => parseMinecraftServerAddress("user@example.com"), /不能是 URL/u);
});

test("自然语言 delegate 原子创建 binding 与首条 mailbox，并在 ready 前不领取", async () => {
  const fixture = await createFixture();
  try {
    const input = {
      serverAddress: "127.0.0.1:25566",
      instruction: "进去看看周围有什么，遇到玩家就打招呼",
      ownerSessionId: "web:owner",
      ownerPrincipalId: "owner",
      idempotencyKey: "delegate-1"
    };
    const first = await fixture.service.delegate(input);
    const replay = await fixture.service.delegate(input);

    assert.equal(first.created, true);
    assert.equal(first.resource.minecraftActor?.binding.provisionStatus, "pending");
    assert.equal(replay.resource.resourceId, first.resource.resourceId);
    assert.equal(replay.requestId, first.requestId);
    assert.equal(replay.replayed, true);
    assert.equal((await fixture.control.listRequests(first.resource.resourceId)).length, 1);
    assert.equal(await fixture.control.claimNextWake(first.resource.resourceId, 2), null);
    assert.equal((await fixture.control.getControlState(first.resource.resourceId))?.loopPhase, "paused");

    const stream = await openMinecraftActorStream({
      minecraftActorManager: {
        list: () => fixture.registry.list("minecraft_actor"),
        get: (resourceId: string) => fixture.registry.get(resourceId),
        probe: async () => { throw new Error("pending actor 不应 probe"); }
      },
      minecraftActorControlStore: fixture.control
    } as unknown as InternalApiMinecraftActorDeps, first.resource.resourceId, null);
    const streamedEventTypes: string[] = [];
    const unsubscribeStream = stream.subscribe(event => {
      if (event.type === "actor_event") streamedEventTypes.push(event.event.eventType);
    });

    await fixture.store.beginAttempt({
      resourceId: first.resource.resourceId,
      attemptId: "attempt-1",
      runtimeInstanceId: "runtime-1",
      socketPath: "/run/mizune/runtime.sock",
      gameDirectory: "/run/mizune/game",
      tokenFile: "/run/mizune/token",
      bootId: "boot-1",
      nowMs: 3
    });
    await assert.rejects(fixture.store.markReady({
      resourceId: first.resource.resourceId,
      attemptId: "attempt-1",
      nowMs: 4
    }), /尚无可用的运行实例/u);
    const incarnation = await fixture.store.markIncarnationRunning({
      resourceId: first.resource.resourceId,
      attemptId: "attempt-1",
      runtimeInstanceId: "runtime-1",
      daemonPid: 123,
      daemonStartTicks: "456",
      processGroupId: 123,
      nowMs: 4
    });
    assert.equal(incarnation.status, "running");
    await fixture.store.markReady({
      resourceId: first.resource.resourceId,
      attemptId: "attempt-1",
      nowMs: 5
    });
    assert.equal((await fixture.store.getActiveIncarnation(first.resource.resourceId))?.runtimeInstanceId, "runtime-1");
    const claimed = await fixture.control.claimNextWake(first.resource.resourceId, 6);
    assert.equal(claimed?.request?.instruction, input.instruction);
    assert.ok(fixture.liveEvents.some(event => event.eventType === "actor_ready"));
    assert.deepEqual(streamedEventTypes, ["actor_provisioning_started", "actor_ready", "decision_started"]);
    unsubscribeStream();
  } finally {
    await fixture.close();
  }
});

test("同账号同服复用 open binding，跨 owner 不能夺取身份租约", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.service.delegate({
      serverAddress: "127.0.0.1:25566",
      instruction: "先观察出生点",
      ownerSessionId: "web:owner-a",
      ownerPrincipalId: "owner-a",
      idempotencyKey: "delegate-a"
    });
    const second = await fixture.service.delegate({
      serverAddress: "127.0.0.1:25566",
      instruction: "然后看看附近玩家",
      ownerSessionId: "web:owner-a",
      ownerPrincipalId: "owner-a",
      idempotencyKey: "delegate-b"
    });
    assert.equal(second.resource.resourceId, first.resource.resourceId);
    assert.equal(second.created, false);
    assert.equal((await fixture.control.listRequests(first.resource.resourceId)).length, 2);

    await assert.rejects(fixture.service.delegate({
      serverAddress: "127.0.0.1:25566",
      instruction: "抢占角色",
      ownerSessionId: "web:owner-b",
      ownerPrincipalId: "owner-b",
      idempotencyKey: "delegate-owner-b"
    }), /另一个主体持有/u);
  } finally {
    await fixture.close();
  }
});

test("新 provision attempt 必须等待旧 incarnation 经进程指纹确认终止", async () => {
  const fixture = await createFixture();
  try {
    const delegated = await fixture.service.delegate({
      serverAddress: "127.0.0.1:25566",
      instruction: "登录后观察环境",
      ownerSessionId: "web:owner",
      ownerPrincipalId: "owner",
      idempotencyKey: "incarnation-guard"
    });
    const resourceId = delegated.resource.resourceId;
    await fixture.store.beginAttempt({
      resourceId,
      attemptId: "attempt-1",
      runtimeInstanceId: "runtime-1",
      socketPath: "/run/mizune/runtime-1.sock",
      gameDirectory: "/run/mizune/game-1",
      tokenFile: "/run/mizune/token-1",
      bootId: "boot-1",
      nowMs: 2
    });
    await fixture.store.markIncarnationRunning({
      resourceId,
      attemptId: "attempt-1",
      runtimeInstanceId: "runtime-1",
      daemonPid: 123,
      daemonStartTicks: "456",
      processGroupId: 123,
      clientPid: 234,
      clientStartTicks: "789",
      nowMs: 3
    });
    fixture.database.getDb().prepare(`
      UPDATE minecraft_actor_bindings SET provision_status = 'failed' WHERE resource_id = ?
    `).run(resourceId);

    const secondAttempt = {
      resourceId,
      attemptId: "attempt-2",
      runtimeInstanceId: "runtime-2",
      socketPath: "/run/mizune/runtime-2.sock",
      gameDirectory: "/run/mizune/game-2",
      tokenFile: "/run/mizune/token-2",
      bootId: "boot-1",
      nowMs: 4
    };
    await assert.rejects(fixture.store.beginAttempt(secondAttempt), /旧实例尚未确认退出/u);
    await fixture.store.markIncarnationStopping({
      resourceId,
      attemptId: "attempt-1",
      runtimeInstanceId: "runtime-1",
      reason: "restart_requested",
      nowMs: 5
    });
    await assert.rejects(fixture.store.beginAttempt(secondAttempt), /旧实例尚未确认退出/u);
    await assert.rejects(fixture.store.markIncarnationTerminated({
      resourceId,
      attemptId: "attempt-1",
      runtimeInstanceId: "runtime-1",
      outcome: "failed",
      exitReason: "daemon exited",
      nowMs: 6
    }), /daemon 进程指纹不能为空/u);
    await assert.rejects(fixture.store.markIncarnationTerminated({
      resourceId,
      attemptId: "attempt-1",
      runtimeInstanceId: "runtime-1",
      outcome: "failed",
      exitReason: "daemon exited",
      expectedDaemonPid: 999,
      expectedDaemonStartTicks: "456",
      expectedClientPid: 234,
      expectedClientStartTicks: "789",
      nowMs: 6
    }), /PID 指纹不匹配/u);
    await assert.rejects(fixture.store.markIncarnationTerminated({
      resourceId,
      attemptId: "attempt-1",
      runtimeInstanceId: "runtime-1",
      outcome: "failed",
      exitReason: "daemon exited",
      expectedDaemonPid: 123,
      expectedDaemonStartTicks: "456",
      nowMs: 6
    }), /client 进程指纹不能为空/u);
    await assert.rejects(fixture.store.markIncarnationTerminated({
      resourceId,
      attemptId: "attempt-1",
      runtimeInstanceId: "runtime-1",
      outcome: "failed",
      exitReason: "daemon exited",
      expectedDaemonPid: 123,
      expectedDaemonStartTicks: "456",
      expectedClientPid: 999,
      expectedClientStartTicks: "789",
      nowMs: 6
    }), /client PID 指纹不匹配/u);
    await fixture.store.markIncarnationTerminated({
      resourceId,
      attemptId: "attempt-1",
      runtimeInstanceId: "runtime-1",
      outcome: "failed",
      exitReason: "daemon exited",
      expectedDaemonPid: 123,
      expectedDaemonStartTicks: "456",
      expectedClientPid: 234,
      expectedClientStartTicks: "789",
      nowMs: 6
    });
    await fixture.store.beginAttempt(secondAttempt);
    assert.equal((await fixture.store.getActiveIncarnation(resourceId))?.runtimeInstanceId, "runtime-2");
    await fixture.store.markIncarnationTerminated({
      resourceId,
      attemptId: "attempt-2",
      runtimeInstanceId: "runtime-2",
      outcome: "stopped",
      exitReason: "stopped before spawn",
      nowMs: 7
    });
    assert.equal(
      (await fixture.registry.get(resourceId))?.minecraftActor?.binding.provisionStatus,
      "stopped"
    );
    await fixture.store.beginAttempt({
      ...secondAttempt,
      attemptId: "attempt-3",
      runtimeInstanceId: "runtime-3",
      nowMs: 8
    });
    assert.equal((await fixture.store.getActiveIncarnation(resourceId))?.runtimeInstanceId, "runtime-3");
  } finally {
    await fixture.close();
  }
});

test("Runtime 终止后必须先收敛 durable decision 才能开始新 attempt", async () => {
  const fixture = await createFixture();
  try {
    const delegated = await fixture.service.delegate({
      serverAddress: "127.0.0.1:25566",
      instruction: "观察出生点",
      ownerSessionId: "web:owner",
      ownerPrincipalId: "owner",
      idempotencyKey: "decision-before-reprovision"
    });
    const resourceId = delegated.resource.resourceId;
    await fixture.store.beginAttempt({
      resourceId,
      attemptId: "attempt-active",
      runtimeInstanceId: "runtime-active",
      socketPath: "/run/mizune/runtime-active.sock",
      gameDirectory: "/run/mizune/game-active",
      tokenFile: "/run/mizune/token-active",
      bootId: "boot-1",
      nowMs: 2
    });
    await fixture.store.markIncarnationRunning({
      resourceId,
      attemptId: "attempt-active",
      runtimeInstanceId: "runtime-active",
      daemonPid: 123,
      daemonStartTicks: "456",
      processGroupId: 123,
      nowMs: 3
    });
    await fixture.store.markReady({ resourceId, attemptId: "attempt-active", nowMs: 4 });
    const claimed = await fixture.control.claimNextWake(resourceId, 5);
    assert.ok(claimed);
    await fixture.store.markIncarnationTerminated({
      resourceId,
      attemptId: "attempt-active",
      runtimeInstanceId: "runtime-active",
      outcome: "failed",
      exitReason: "daemon exited",
      expectedDaemonPid: 123,
      expectedDaemonStartTicks: "456",
      nowMs: 6
    });
    const nextAttempt = {
      resourceId,
      attemptId: "attempt-after-decision",
      runtimeInstanceId: "runtime-after-decision",
      socketPath: "/run/mizune/runtime-after.sock",
      gameDirectory: "/run/mizune/game-after",
      tokenFile: "/run/mizune/token-after",
      bootId: "boot-1",
      nowMs: 7
    };
    await assert.rejects(fixture.store.beginAttempt(nextAttempt), /决策尚未收敛/u);
    await fixture.control.completeDecision({
      resourceId,
      wakeId: claimed.wake.wakeId,
      decisionId: claimed.decision.decisionId,
      status: "failed",
      error: "runtime exited",
      retryAtMs: 8,
      nowMs: 8
    });
    await fixture.store.beginAttempt({ ...nextAttempt, nowMs: 9 });
    const runningWakeCount = fixture.database.getDb().prepare(`
      SELECT COUNT(*) AS count FROM minecraft_actor_wake_mailbox
      WHERE resource_id = ? AND status = 'running'
    `).get(resourceId) as { count: number };
    assert.equal(runningWakeCount.count, 0);
  } finally {
    await fixture.close();
  }
});

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "minecraft-provisioning-test-"));
  const database = new StateDatabase(dataDir, createSilentLogger());
  const registry = new RuntimeResourceRegistry(new RuntimeResourceStore(database));
  const journal = new MinecraftActorJournal();
  const store = new MinecraftActorProvisioningStore(database, journal);
  const control = new MinecraftActorControlStore(database, journal);
  const liveEvents: Array<{ eventType: string }> = [];
  const unsubscribe = control.subscribe(event => liveEvents.push(event));
  const config = createTestAppConfig({
    minecraft: {
      enabled: true,
      runtimeDir: join(dataDir, "run"),
      templates: {
        local: {
          backend: "simulation",
          minecraftVersion: "1.21.1",
          loader: "vanilla",
          gameProfileId: "test-profile",
          identityRef: "test-identity",
          allowedServers: ["127.0.0.1:25566"],
          modelRefs: ["test-model"]
        }
      }
    }
  });
  const service = new MinecraftActorProvisioningService(
    new MinecraftRuntimeTemplateCatalog(config),
    store,
    registry,
    config.minecraft.runtimeDir,
    () => 1
  );
  return {
    service,
    store,
    control,
    registry,
    database,
    liveEvents,
    async close() {
      unsubscribe();
      database.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}
