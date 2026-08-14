import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AppConfig } from "#config/config.ts";
import type { Logger } from "pino";
import type {
  MinecraftRuntimeIncarnationRecord,
  RuntimeResourceRecord
} from "#runtime/resources/resourceTypes.ts";
import type { RuntimeResourceRegistry } from "#runtime/resources/runtimeResourceRegistry.ts";
import { ProtocolMinecraftActorClient } from "./actorClient.ts";
import type { MinecraftActorProvisioningStore } from "./actorProvisioningStore.ts";
import {
  matchesLinuxProcessIdentity,
  readCurrentBootId,
  readSpawnedProcessIdentity
} from "./processIdentity.ts";
import type { MinecraftRuntimeTemplateCatalog } from "./runtimeTemplateCatalog.ts";
import { UnixSocketMinecraftActorTransport } from "./unixSocketTransport.ts";

interface ManagedRuntimeProcess {
  resourceId: string;
  actorId: string;
  attemptId: string;
  runtimeInstanceId: string;
  pid: number;
  processGroupId: number;
  startTicks: string;
  bootId: string;
  socketPath: string;
  tokenFile: string;
  child: ChildProcess | null;
  termination: Promise<ChildTermination> | null;
  stopping: boolean;
  stopOutcome: "stopped" | "failed";
  stopOperation: Promise<void> | null;
  finalization: Promise<void> | null;
}

type ChildTermination =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error"; error: Error };

interface ObservedChild {
  child: ChildProcess;
  termination: Promise<ChildTermination>;
}

export class MinecraftRuntimeProcessSupervisor {
  private readonly operations = new Map<string, Promise<void>>();
  private readonly processes = new Map<string, ManagedRuntimeProcess>();
  private readonly shutdownController = new AbortController();
  private stopOperation: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly config: AppConfig,
    private readonly registry: RuntimeResourceRegistry,
    private readonly provisioningStore: MinecraftActorProvisioningStore,
    private readonly templates: MinecraftRuntimeTemplateCatalog,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now
  ) {}

  async start(): Promise<void> {
    if (!this.config.minecraft.enabled || this.stopping) return;
    await this.reconcile();
  }

  async reconcile(): Promise<void> {
    if (this.stopping || !this.config.minecraft.enabled) return;
    const resources = await this.registry.list("minecraft_actor");
    for (const resource of resources) {
      this.schedule(resource);
    }
  }

  stop(): Promise<void> {
    this.stopOperation ??= this.performStop();
    return this.stopOperation;
  }

  private async performStop(): Promise<void> {
    this.stopping = true;
    this.shutdownController.abort(new Error("minecraft_runtime_supervisor_shutdown"));
    await Promise.allSettled([...this.operations.values()]);
    const resources = await this.registry.list("minecraft_actor");
    const failures: unknown[] = [];
    for (const resource of resources) {
      const incarnation = await this.provisioningStore.getActiveIncarnation(resource.resourceId);
      if (!incarnation) continue;
      try {
        await this.stopIncarnation(resource, incarnation, "parent_shutdown");
      } catch (error) {
        failures.push(error);
        this.logger.error({ err: error, resourceId: resource.resourceId }, "minecraft_runtime_shutdown_failed");
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Minecraft Runtime supervisor 未能安全收敛所有进程");
    }
  }

  private schedule(resource: RuntimeResourceRecord): void {
    if (this.operations.has(resource.resourceId)) return;
    const operation = this.reconcileResource(resource)
      .catch(error => {
        this.logger.warn({ err: error, resourceId: resource.resourceId }, "minecraft_runtime_reconcile_failed");
      })
      .finally(() => {
        if (this.operations.get(resource.resourceId) === operation) {
          this.operations.delete(resource.resourceId);
        }
      });
    this.operations.set(resource.resourceId, operation);
  }

  private async reconcileResource(initial: RuntimeResourceRecord): Promise<void> {
    const current = await this.registry.get(initial.resourceId);
    const actor = current?.minecraftActor;
    if (!current || !actor) return;
    const binding = actor.binding;
    const incarnation = await this.provisioningStore.getActiveIncarnation(current.resourceId);

    if (current.status !== "active" || binding.desiredState === "closed") {
      if (incarnation) await this.stopIncarnation(current, incarnation, "actor_closed");
      return;
    }

    if (binding.backend !== "simulation") {
      await this.provisioningStore.markNeedsAttention({
        resourceId: current.resourceId,
        failureCode: "backend_not_implemented",
        failureMessage: "当前切片尚未启用 NeoForge 客户端 supervisor",
        phase: "resolving_template",
        nowMs: this.now()
      });
      if (incarnation && !(await this.provisioningStore.hasActiveDecision(current.resourceId))) {
        await this.stopIncarnation(current, incarnation, "runtime_backend_revoked");
      }
      return;
    }

    if (incarnation) {
      if (binding.provisionStatus === "needs_attention" || binding.provisionStatus === "failed") {
        if (!(await this.provisioningStore.hasActiveDecision(current.resourceId))) {
          await this.stopIncarnation(current, incarnation, "runtime_policy_revoked");
        }
        return;
      }
      await this.reconcileExistingIncarnation(current, incarnation);
      return;
    }
    if (
      binding.provisionStatus === "needs_attention"
      || binding.provisionStatus === "ready"
      || binding.provisionStatus === "failed"
    ) return;
    if (binding.provisionStatus === "retry_wait" && binding.retryAtMs !== null && binding.retryAtMs > this.now()) return;
    await this.startSimulationRuntime(current);
  }

  private async reconcileExistingIncarnation(
    resource: RuntimeResourceRecord,
    incarnation: MinecraftRuntimeIncarnationRecord
  ): Promise<void> {
    if (incarnation.status === "stopping") {
      await this.stopIncarnation(resource, incarnation, "resume_runtime_stop");
      return;
    }
    const handle = await this.resolveRunningHandle(resource, incarnation);
    if (!handle) return;
    if (resource.minecraftActor?.binding.provisionStatus === "running") {
      await this.waitUntilReady(resource, incarnation.socketPath, incarnation.runtimeInstanceId);
      await this.provisioningStore.markReady({
        resourceId: resource.resourceId,
        attemptId: incarnation.attemptId,
        nowMs: this.now()
      });
    }
  }

  private async resolveRunningHandle(
    resource: RuntimeResourceRecord,
    incarnation: MinecraftRuntimeIncarnationRecord
  ): Promise<ManagedRuntimeProcess | null> {
    const existing = this.processes.get(resource.resourceId);
    if (existing?.runtimeInstanceId === incarnation.runtimeInstanceId) return existing;
    const recovered = await this.recoverProcessIdentity(resource, incarnation, "running");
    if (!recovered) {
      await this.provisioningStore.markNeedsAttention({
        resourceId: resource.resourceId,
        failureCode: "unverified_orphan_process",
        failureMessage: "Runtime 启动身份未完成登记；为避免重复登录，已停止自动重试",
        phase: "waiting_daemon",
        nowMs: this.now()
      });
      return null;
    }
    if (!(await isHandleAlive(recovered))) {
      await this.finalizeMissingIncarnation(recovered, "failed", "受管 Runtime 进程已不存在或 PID 身份不匹配");
      return null;
    }
    this.processes.set(resource.resourceId, recovered);
    return recovered;
  }

  private async stopIncarnation(
    resource: RuntimeResourceRecord,
    incarnation: MinecraftRuntimeIncarnationRecord,
    reason: string
  ): Promise<void> {
    const existing = this.processes.get(resource.resourceId);
    const handle = existing?.runtimeInstanceId === incarnation.runtimeInstanceId
      ? existing
      : await this.recoverProcessIdentity(resource, incarnation, "stopping");
    if (!handle) {
      throw new Error(`无法确认待停止 Runtime 的进程身份：${incarnation.runtimeInstanceId}`);
    }
    if (!(await isHandleAlive(handle))) {
      await this.finalizeMissingIncarnation(handle, "stopped", "受管 Runtime 已在回收前退出");
      return;
    }
    this.processes.set(resource.resourceId, handle);
    await this.stopHandle(handle, reason);
  }

  private async recoverProcessIdentity(
    resource: RuntimeResourceRecord,
    incarnation: MinecraftRuntimeIncarnationRecord,
    targetStatus: "running" | "stopping"
  ): Promise<ManagedRuntimeProcess | null> {
    if (incarnation.daemonPid && incarnation.daemonStartTicks && incarnation.processGroupId) {
      return this.adoptHandle(resource, incarnation);
    }
    const registration = await waitForPidRegistration(
      resolve(dirname(incarnation.socketPath), "runtime.pid.json"),
      incarnation.runtimeInstanceId,
      this.config.minecraft.supervisor.startupTimeoutMs,
      targetStatus === "running" ? this.shutdownController.signal : undefined
    );
    if (!registration || registration.bootId !== incarnation.bootId) return null;
    if (!(await matchesLinuxProcessIdentity(registration))) return createManagedHandle({
      resourceId: resource.resourceId,
      actorId: resource.minecraftActor?.actorId ?? "unknown",
      attemptId: incarnation.attemptId,
      runtimeInstanceId: incarnation.runtimeInstanceId,
      pid: registration.pid,
      processGroupId: registration.pid,
      startTicks: registration.startTicks,
      bootId: registration.bootId,
      socketPath: incarnation.socketPath,
      tokenFile: incarnation.tokenFile,
      child: null,
      termination: null
    });
    const recovered = await this.provisioningStore.recordRecoveredProcessIdentity({
      resourceId: resource.resourceId,
      attemptId: incarnation.attemptId,
      runtimeInstanceId: incarnation.runtimeInstanceId,
      daemonPid: registration.pid,
      daemonStartTicks: registration.startTicks,
      processGroupId: registration.pid,
      targetStatus,
      nowMs: this.now()
    });
    return this.adoptHandle(resource, recovered);
  }

  private async startSimulationRuntime(resource: RuntimeResourceRecord): Promise<void> {
    const actor = resource.minecraftActor;
    if (!actor) return;
    const template = this.templates.resolveById(actor.binding.templateId);
    if (template.backend !== "simulation") return;
    const paths = await this.prepareRuntimeDirectory(resource.resourceId);
    const attemptId = `attempt_${randomUUID()}`;
    const runtimeInstanceId = `runtime_${randomUUID()}`;
    const nowMs = this.now();
    await this.provisioningStore.beginAttempt({
      resourceId: resource.resourceId,
      attemptId,
      runtimeInstanceId,
      socketPath: paths.socketPath,
      gameDirectory: paths.gameDirectory,
      tokenFile: paths.tokenFile,
      bootId: await readCurrentBootId(),
      nowMs
    });
    await this.provisioningStore.advanceAttempt({
      resourceId: resource.resourceId,
      attemptId,
      phase: "starting_daemon",
      nowMs: this.now()
    });

    let handle: ManagedRuntimeProcess | null = null;
    try {
      const observed = this.spawnSimulationDaemon({
        actorId: actor.actorId,
        runtimeInstanceId,
        socketPath: paths.socketPath,
        databasePath: paths.databasePath,
        pidFile: paths.pidFile,
        tokenFile: paths.tokenFile
      });
      const identity = await readObservedChildIdentity(observed);
      handle = createManagedHandle({
        resourceId: resource.resourceId,
        actorId: actor.actorId,
        attemptId,
        runtimeInstanceId,
        pid: identity.pid,
        processGroupId: identity.pid,
        startTicks: identity.startTicks,
        bootId: identity.bootId,
        socketPath: paths.socketPath,
        tokenFile: paths.tokenFile,
        child: observed.child,
        termination: observed.termination
      });
      this.processes.set(resource.resourceId, handle);
      await this.provisioningStore.markIncarnationRunning({
        resourceId: resource.resourceId,
        attemptId,
        runtimeInstanceId,
        daemonPid: identity.pid,
        daemonStartTicks: identity.startTicks,
        processGroupId: identity.pid,
        nowMs: this.now()
      });
      this.attachChild(handle);
      await this.provisioningStore.advanceAttempt({
        resourceId: resource.resourceId,
        attemptId,
        phase: "waiting_daemon",
        nowMs: this.now()
      });
      await this.waitUntilReady(resource, paths.socketPath, runtimeInstanceId);
      await this.provisioningStore.markReady({
        resourceId: resource.resourceId,
        attemptId,
        nowMs: this.now()
      });
      this.logger.info({ resourceId: resource.resourceId, pid: identity.pid }, "minecraft_runtime_ready");
    } catch (error) {
      const stoppedForShutdown = this.stopping || isAbortError(error);
      if (handle) {
        await this.stopHandle(
          handle,
          stoppedForShutdown ? "parent_shutdown_during_start" : "runtime_start_failed",
          stoppedForShutdown ? "stopped" : "failed"
        ).catch(stopError => {
          this.logger.error({ err: stopError, resourceId: resource.resourceId }, "minecraft_runtime_start_cleanup_failed");
        });
      } else {
        const incarnation = await this.provisioningStore.getActiveIncarnation(resource.resourceId);
        if (incarnation?.runtimeInstanceId === runtimeInstanceId) {
          await this.provisioningStore.markIncarnationTerminated({
            resourceId: resource.resourceId,
            attemptId,
            runtimeInstanceId,
            outcome: stoppedForShutdown ? "stopped" : "failed",
            exitReason: errorMessage(error),
            failureCode: stoppedForShutdown ? null : "runtime_spawn_failed",
            retryAtMs: stoppedForShutdown ? null : await this.nextRetryAt(resource.resourceId),
            nowMs: this.now()
          });
        }
      }
      throw error;
    }
  }

  private spawnSimulationDaemon(input: {
    actorId: string;
    runtimeInstanceId: string;
    socketPath: string;
    databasePath: string;
    pidFile: string;
    tokenFile: string;
  }): ObservedChild {
    const supervisor = this.config.minecraft.supervisor;
    const modulePath = resolveTrustedPath(supervisor.pythonModulePath);
    const child = spawn(supervisor.pythonExecutable, [
      "-m",
      "mizune_mc_runtime.daemon",
      "--socket",
      input.socketPath,
      "--database",
      input.databasePath,
      "--actor-id",
      input.actorId,
      "--runtime-instance-id",
      input.runtimeInstanceId,
      "--pid-file",
      input.pidFile,
      "--auth-token-file",
      input.tokenFile
    ], {
      cwd: process.cwd(),
      detached: true,
      shell: false,
      env: buildDaemonEnvironment(modulePath),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const observed = observeChild(child);
    drainChildLogs(child, this.logger, this.config.minecraft.supervisor.maxLogLineChars);
    return observed;
  }

  private async waitUntilReady(
    resource: RuntimeResourceRecord,
    socketPath: string,
    runtimeInstanceId: string
  ): Promise<void> {
    const actor = resource.minecraftActor;
    if (!actor) throw new Error("Minecraft Actor 状态缺失");
    const deadline = Date.now() + this.config.minecraft.supervisor.startupTimeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      throwIfAborted(this.shutdownController.signal);
      const transport = new UnixSocketMinecraftActorTransport({
        socketPath,
        actorId: actor.actorId,
        requestTimeoutMs: this.config.minecraft.requestTimeoutMs,
        connectTimeoutMs: Math.min(this.config.minecraft.connectTimeoutMs, 500),
        maxFrameBytes: this.config.minecraft.maxFrameBytes,
        clientName: "mizune-supervisor-readiness",
        runtimeInstanceId,
        authTokenFile: resolve(dirname(socketPath), "auth.token")
      });
      const client = new ProtocolMinecraftActorClient(actor.actorId, transport);
      try {
        await client.getSnapshot();
        await transport.releaseController();
        await client.close();
        return;
      } catch (error) {
        lastError = error;
        await client.close().catch(() => undefined);
        await delay(50);
      }
    }
    throw new Error(`等待 Minecraft Runtime 就绪超时：${errorMessage(lastError)}`);
  }

  private async prepareRuntimeDirectory(resourceId: string): Promise<{
    socketPath: string;
    databasePath: string;
    gameDirectory: string;
    tokenFile: string;
    pidFile: string;
  }> {
    if (!/^res_minecraft_[a-zA-Z0-9_-]+$/u.test(resourceId)) {
      throw new Error(`Minecraft resource ID 不能用于运行目录：${resourceId}`);
    }
    const runtimeRoot = resolve(this.config.minecraft.runtimeDir);
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await chmod(runtimeRoot, 0o700);
    const canonicalRoot = await realpath(runtimeRoot);
    const resourceRoot = resolve(canonicalRoot, resourceId);
    assertContained(canonicalRoot, resourceRoot);
    await ensurePrivateDirectory(resourceRoot);
    const gameDirectory = resolve(resourceRoot, "game");
    await ensurePrivateDirectory(gameDirectory);
    const socketPath = resolve(resourceRoot, "runtime.sock");
    if (Buffer.byteLength(socketPath) > 100) {
      throw new Error(`Minecraft Runtime socket 路径过长：${socketPath.length}`);
    }
    const tokenFile = resolve(resourceRoot, "auth.token");
    await writePrivateFile(tokenFile, randomBytes(32).toString("base64url"));
    await rejectSymlink(resolve(resourceRoot, "runtime.sqlite"));
    return {
      socketPath,
      databasePath: resolve(resourceRoot, "runtime.sqlite"),
      gameDirectory,
      tokenFile,
      pidFile: resolve(resourceRoot, "runtime.pid.json")
    };
  }

  private attachChild(handle: ManagedRuntimeProcess): void {
    if (!handle.termination) return;
    void handle.termination.then(termination => {
      const outcome = handle.stopping || this.stopping ? handle.stopOutcome : "failed";
      const reason = termination.kind === "error"
        ? `Runtime 进程错误：${termination.error.message}`
        : `Runtime 进程退出：code=${String(termination.code)}, signal=${String(termination.signal)}`;
      return this.finalizeHandleOnce(handle, outcome, reason);
    }).catch(error => {
        this.logger.error({ err: error, resourceId: handle.resourceId }, "minecraft_runtime_exit_finalize_failed");
    });
  }

  private async stopHandle(
    handle: ManagedRuntimeProcess,
    reason: string,
    outcome: "stopped" | "failed" = "stopped"
  ): Promise<void> {
    if (!handle.stopOperation) {
      const operation = this.performStopHandle(handle, reason, outcome).catch(error => {
        if (handle.stopOperation === operation) handle.stopOperation = null;
        throw error;
      });
      handle.stopOperation = operation;
    }
    return handle.stopOperation;
  }

  private async performStopHandle(
    handle: ManagedRuntimeProcess,
    reason: string,
    outcome: "stopped" | "failed"
  ): Promise<void> {
    handle.stopping = true;
    handle.stopOutcome = outcome;
    const incarnation = await this.provisioningStore.getActiveIncarnation(handle.resourceId);
    if (incarnation && incarnation.runtimeInstanceId === handle.runtimeInstanceId && incarnation.status !== "stopping") {
      await this.provisioningStore.markIncarnationStopping({
        resourceId: handle.resourceId,
        attemptId: handle.attemptId,
        runtimeInstanceId: handle.runtimeInstanceId,
        reason,
        nowMs: this.now()
      });
    }
    if (!(await signalOwnedProcessGroup(handle, "SIGTERM"))) {
      await this.finalizeHandleOnce(handle, outcome, reason);
      return;
    }
    let exited = await waitForProcessExit(handle, this.config.minecraft.supervisor.stopGraceMs);
    if (!exited) {
      if (!(await signalOwnedProcessGroup(handle, "SIGKILL"))) {
        await this.finalizeHandleOnce(handle, outcome, reason);
        return;
      }
      exited = await waitForProcessExit(handle, 2_000);
    }
    if (!exited) {
      throw new Error(`Runtime 进程经 SIGKILL 后仍未确认退出：${handle.runtimeInstanceId}`);
    }
    await this.finalizeHandleOnce(handle, outcome, reason);
  }

  private finalizeHandleOnce(
    handle: ManagedRuntimeProcess,
    outcome: "stopped" | "failed",
    reason: string
  ): Promise<void> {
    handle.finalization ??= this.finalizeExitedHandle(handle, outcome, reason);
    return handle.finalization;
  }

  private async finalizeExitedHandle(
    handle: ManagedRuntimeProcess,
    outcome: "stopped" | "failed",
    reason: string
  ): Promise<void> {
    try {
      const retryAtMs = outcome === "failed" ? await this.nextRetryAt(handle.resourceId) : null;
      const incarnation = await this.provisioningStore.getActiveIncarnation(handle.resourceId);
      const identityWasPersisted = incarnation?.runtimeInstanceId === handle.runtimeInstanceId
        && incarnation.daemonPid === handle.pid
        && incarnation.daemonStartTicks === handle.startTicks;
      await this.provisioningStore.markIncarnationTerminated({
        resourceId: handle.resourceId,
        attemptId: handle.attemptId,
        runtimeInstanceId: handle.runtimeInstanceId,
        outcome,
        exitReason: reason,
        ...(identityWasPersisted
          ? {
              expectedDaemonPid: handle.pid,
              expectedDaemonStartTicks: handle.startTicks
            }
          : {}),
        retryAtMs,
        nowMs: this.now()
      });
    } finally {
      if (this.processes.get(handle.resourceId) === handle) this.processes.delete(handle.resourceId);
    }
  }

  private adoptHandle(
    resource: RuntimeResourceRecord,
    incarnation: MinecraftRuntimeIncarnationRecord
  ): ManagedRuntimeProcess {
    if (!incarnation.daemonPid || !incarnation.daemonStartTicks || !incarnation.processGroupId) {
      throw new Error(`Minecraft Runtime 进程指纹不完整：${incarnation.runtimeInstanceId}`);
    }
    if (incarnation.processGroupId !== incarnation.daemonPid) {
      throw new Error(`Minecraft Runtime 进程组不属于 daemon leader：${incarnation.runtimeInstanceId}`);
    }
    return createManagedHandle({
      resourceId: resource.resourceId,
      actorId: resource.minecraftActor?.actorId ?? "unknown",
      attemptId: incarnation.attemptId,
      runtimeInstanceId: incarnation.runtimeInstanceId,
      pid: incarnation.daemonPid,
      processGroupId: incarnation.processGroupId,
      startTicks: incarnation.daemonStartTicks,
      bootId: incarnation.bootId,
      socketPath: incarnation.socketPath,
      tokenFile: incarnation.tokenFile,
      child: null,
      termination: null
    });
  }

  private async finalizeMissingIncarnation(
    handle: ManagedRuntimeProcess,
    outcome: "stopped" | "failed",
    reason: string
  ): Promise<void> {
    await this.finalizeHandleOnce(handle, outcome, reason);
  }

  private async nextRetryAt(resourceId: string): Promise<number | null> {
    const supervisor = this.config.minecraft.supervisor;
    const previousFailures = await this.provisioningStore.countFailedIncarnationsSince(
      resourceId,
      Math.max(0, this.now() - supervisor.restartWindowMs)
    );
    const attemptsIncludingCurrent = previousFailures + 1;
    if (attemptsIncludingCurrent >= supervisor.maxRestartAttempts) return null;
    return this.now() + Math.min(30_000, 1_000 * 2 ** previousFailures);
  }
}

function createManagedHandle(input: Omit<
  ManagedRuntimeProcess,
  "stopping" | "stopOutcome" | "stopOperation" | "finalization"
>): ManagedRuntimeProcess {
  return {
    ...input,
    stopping: false,
    stopOutcome: "stopped",
    stopOperation: null,
    finalization: null
  };
}

async function waitForProcessExit(handle: ManagedRuntimeProcess, timeoutMs: number): Promise<boolean> {
  if (!(await isHandleAlive(handle))) return true;
  if (handle.termination) {
    const observed = await Promise.race([
      handle.termination.then(() => true),
      delay(timeoutMs).then(() => false)
    ]);
    if (observed) return true;
    return !(await isHandleAlive(handle));
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isHandleAlive(handle))) return true;
    await delay(25);
  }
  return !(await isHandleAlive(handle));
}

async function signalOwnedProcessGroup(
  handle: ManagedRuntimeProcess,
  signal: NodeJS.Signals
): Promise<boolean> {
  if (handle.processGroupId !== handle.pid) {
    throw new Error(`拒绝向非 daemon leader 进程组发送信号：${handle.runtimeInstanceId}`);
  }
  if (!(await isHandleAlive(handle))) return false;
  try {
    process.kill(-handle.processGroupId, signal);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    throw error;
  }
}

function isHandleAlive(handle: ManagedRuntimeProcess): Promise<boolean> {
  return matchesLinuxProcessIdentity({
    pid: handle.pid,
    startTicks: handle.startTicks,
    bootId: handle.bootId
  });
}

function observeChild(child: ChildProcess): ObservedChild {
  const termination = new Promise<ChildTermination>(resolveTermination => {
    let settled = false;
    const settle = (value: ChildTermination) => {
      if (settled) return;
      settled = true;
      resolveTermination(value);
    };
    child.once("error", error => settle({ kind: "error", error }));
    child.once("exit", (code, signal) => settle({ kind: "exit", code, signal }));
  });
  return { child, termination };
}

async function readObservedChildIdentity(observed: ObservedChild) {
  const pid = observed.child.pid;
  if (!pid) {
    const termination = await observed.termination;
    throw childTerminationError(termination);
  }
  return Promise.race([
    readSpawnedProcessIdentity(pid),
    observed.termination.then(termination => {
      throw childTerminationError(termination);
    })
  ]);
}

function childTerminationError(termination: ChildTermination): Error {
  if (termination.kind === "error") return termination.error;
  return new Error(
    `Minecraft Runtime 在身份登记前退出：code=${String(termination.code)}, signal=${String(termination.signal)}`
  );
}

function buildDaemonEnvironment(modulePath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PYTHONUNBUFFERED: "1",
    PYTHONPATH: modulePath
  };
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ"] as const) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

function resolveTrustedPath(value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

function assertContained(parent: string, candidate: string): void {
  const path = relative(parent, candidate);
  if (!path || path.startsWith("..") || isAbsolute(path)) {
    throw new Error(`Minecraft Runtime 路径越界：${candidate}`);
  }
}

function drainChildLogs(child: ChildProcess, logger: Logger, maxChars: number): void {
  drain(child.stdout, "info");
  drain(child.stderr, "warn");

  function drain(stream: NodeJS.ReadableStream | null, level: "info" | "warn"): void {
    if (!stream) return;
    let buffered = "";
    stream.setEncoding("utf8");
    stream.on("data", chunk => {
      buffered += String(chunk);
      const lines = buffered.split(/\r?\n/u);
      buffered = lines.pop() ?? "";
      for (const line of lines) log(line);
      if (buffered.length > maxChars * 2) {
        log(buffered);
        buffered = "";
      }
    });
    stream.on("end", () => {
      if (buffered) log(buffered);
    });
    function log(value: string): void {
      const line = redact(value).slice(0, maxChars);
      if (line) logger[level]({ line }, "minecraft_runtime_child_log");
    }
  }
}

function redact(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)\S+/giu, "$1[REDACTED]")
    .replace(/((?:token|password|secret)\s*[:=]\s*)\S+/giu, "$1[REDACTED]");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForPidRegistration(
  pidFile: string,
  expectedRuntimeInstanceId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ pid: number; startTicks: string; bootId: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal) throwIfAborted(signal);
    try {
      const parsed: unknown = JSON.parse(await readFile(pidFile, "utf8"));
      if (
        isRecord(parsed)
        && parsed.runtimeInstanceId === expectedRuntimeInstanceId
        && Number.isSafeInteger(parsed.pid)
        && (parsed.pid as number) > 0
        && typeof parsed.startTicks === "string"
        && /^\d+$/u.test(parsed.startTicks)
        && typeof parsed.bootId === "string"
        && parsed.bootId.length > 0
      ) {
        return {
          pid: parsed.pid as number,
          startTicks: parsed.startTicks,
          bootId: parsed.bootId
        };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isMissingFile(error)) throw error;
    }
    await delay(25);
  }
  return null;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) {
      throw error;
    }
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Minecraft Runtime 私有目录无效：${path}`);
  }
  await chmod(path, 0o700);
}

async function writePrivateFile(path: string, value: string): Promise<void> {
  const descriptor = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await descriptor.chmod(0o600);
    await descriptor.writeFile(value, "utf8");
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Minecraft Runtime 文件不能是符号链接：${path}`);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Minecraft Runtime supervisor 已停止");
  error.name = "AbortError";
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isErrno(error, "ENOENT");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
