import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { loadConfig, type AppConfig } from "#config/config.ts";
import { StateDatabase } from "#data/state/stateDatabase.ts";
import { LlmClient } from "#llm/llmClient.ts";
import { RuntimeResourceRegistry } from "#runtime/resources/runtimeResourceRegistry.ts";
import { RuntimeResourceStore } from "#runtime/resources/runtimeResourceStore.ts";
import { ProtocolMinecraftActorClient } from "#services/minecraft/actorClient.ts";
import {
  acquireMinecraftClientProfileLock
} from "#services/minecraft/clientProfileLock.ts";
import { MinecraftActorJournal } from "#services/minecraft/actorJournal.ts";
import { MinecraftActorProvisioningService } from "#services/minecraft/actorProvisioningService.ts";
import { MinecraftActorProvisioningStore } from "#services/minecraft/actorProvisioningStore.ts";
import { MinecraftDecisionRunner } from "#services/minecraft/decisionRunner.ts";
import { MinecraftRuntimeTemplateCatalog } from "#services/minecraft/runtimeTemplateCatalog.ts";
import { MinecraftRuntimeProcessSupervisor } from "#services/minecraft/runtimeProcessSupervisor.ts";
import { parseMinecraftServerAddress } from "#services/minecraft/serverTarget.ts";
import { UnixSocketMinecraftActorTransport } from "#services/minecraft/unixSocketTransport.ts";

await main();

async function main(): Promise<void> {
  const instance = process.env.CONFIG_INSTANCE?.trim();
  if (!instance) {
    throw new Error("请通过 CONFIG_INSTANCE 指定包含真实 NeoForge clientProfile 的实例，例如 dev");
  }
  const serverAddress = process.env.MIZUNE_MC_SMOKE_SERVER?.trim() || "127.0.0.1:25566";
  const timeoutMs = parsePositiveInteger(process.env.MIZUNE_MC_SMOKE_TIMEOUT_MS, 180_000);
  const decisionModelRef = process.env.MIZUNE_MC_SMOKE_DECISION_MODEL?.trim() || null;
  const decisionTimeoutMs = parsePositiveInteger(process.env.MIZUNE_MC_SMOKE_DECISION_TIMEOUT_MS, 12_000);
  const logger = pino({ level: process.env.MIZUNE_MC_SMOKE_LOG_LEVEL || "warn" });
  const loadedConfig = loadConfig({ ...process.env, CONFIG_INSTANCE: instance });
  if (!loadedConfig.minecraft.enabled) throw new Error(`实例 ${instance} 未启用 minecraft`);
  const selectedTemplate = new MinecraftRuntimeTemplateCatalog(loadedConfig)
    .resolveForTarget(parseMinecraftServerAddress(serverAddress));
  if (!selectedTemplate.clientProfile) throw new Error("真实 NeoForge smoke 缺少 clientProfile");
  const preflightLock = await acquireMinecraftClientProfileLock(
    selectedTemplate.clientProfile.gameDirectory,
    `smoke_preflight_${randomUUID()}`
  );
  try {
    await assertClientProfileIdle(
      selectedTemplate.clientProfile.gameDirectory,
      selectedTemplate.clientProfile.arguments
    );
    await resumeReconnectIfAuthorized(selectedTemplate.clientProfile.gameDirectory, logger);
  } finally {
    await preflightLock.release();
  }

  const dataDir = await mkdtemp(join(tmpdir(), "mizune-managed-neoforge-smoke-"));
  const controller = new AbortController();
  const onSigint = () => controller.abort(new Error("收到 SIGINT"));
  const onSigterm = () => controller.abort(new Error("收到 SIGTERM"));
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const runtimeDir = join(dataDir, "run");
  const config: AppConfig = {
    ...loadedConfig,
    dataDir,
    minecraft: {
      ...loadedConfig.minecraft,
      runtimeDir
    }
  };

  let database: StateDatabase | null = null;
  let supervisor: MinecraftRuntimeProcessSupervisor | null = null;
  let transport: UnixSocketMinecraftActorTransport | null = null;
  let runFailure: unknown = null;
  let runCompleted = false;
  const cleanupFailures: unknown[] = [];
  try {
    database = new StateDatabase(dataDir, logger);
    const registry = new RuntimeResourceRegistry(new RuntimeResourceStore(database));
    const journal = new MinecraftActorJournal();
    const provisioningStore = new MinecraftActorProvisioningStore(database, journal);
    const templates = new MinecraftRuntimeTemplateCatalog(config);
    const provisioning = new MinecraftActorProvisioningService(
      templates,
      provisioningStore,
      registry,
      runtimeDir
    );
    supervisor = new MinecraftRuntimeProcessSupervisor(
      config,
      registry,
      provisioningStore,
      templates,
      logger
    );
    const instruction = "登录服务器，看看周围环境，然后在游戏聊天里向服务器里的大家打个简短的招呼。";
    const delegated = await provisioning.delegate({
      serverAddress,
      instruction,
      ownerSessionId: "smoke:managed-neoforge",
      ownerPrincipalId: "smoke-owner",
      idempotencyKey: `managed-neoforge-smoke:${randomUUID()}`,
      title: `真实 NeoForge 联调 ${serverAddress}`
    });
    const resourceId = delegated.resource.resourceId;
    const actorId = delegated.resource.minecraftActor?.actorId;
    if (!actorId) throw new Error("委派结果缺少 Minecraft actorId");

    logger.info({ resourceId, actorId, serverAddress, dataDir }, "minecraft_smoke_delegated");
    await supervisor.start();
    const ready = await waitForReady({
      resourceId,
      timeoutMs,
      signal: controller.signal,
      supervisor,
      registry,
      logger
    });
    const incarnation = await provisioningStore.getActiveIncarnation(resourceId);
    if (!incarnation) throw new Error("资源 ready 后没有活动 Runtime incarnation");

    transport = new UnixSocketMinecraftActorTransport({
      socketPath: incarnation.socketPath,
      actorId,
      requestTimeoutMs: 10_000,
      connectTimeoutMs: 10_000,
      maxFrameBytes: 1_048_576,
      runtimeInstanceId: incarnation.runtimeInstanceId,
      authTokenFile: incarnation.tokenFile,
      clientName: "mizune-managed-neoforge-smoke",
      clientVersion: "1"
    });
    const client = new ProtocolMinecraftActorClient(actorId, transport);
    const [snapshot, environment, inventory, players, entities] = await Promise.all([
      client.getSnapshot(controller.signal),
      client.observe({ scope: "environment" }, controller.signal),
      client.observe({ scope: "inventory" }, controller.signal),
      client.observe({ scope: "entities", kind: "player", radius: 64, limit: 32 }, controller.signal),
      client.observe({ scope: "entities", radius: 32, limit: 64 }, controller.signal)
    ]);

    const existingChat = await client.observe({ scope: "chat", limit: 100 }, controller.signal);
    const previousMessageIds = collectMessageIds(existingChat.value);
    let decisionLoop: Record<string, unknown> | null = null;
    if (decisionModelRef) {
      const llm = new LlmClient(config, logger);
      if (!llm.isConfigured(decisionModelRef)) {
        throw new Error(`真实 Minecraft 决策模型未配置：${decisionModelRef}`);
      }
      const decision = await new MinecraftDecisionRunner(llm, client, logger).run({
        actorId,
        persistentState: ready.minecraftActor?.persistentState ?? "尚无持久经历。",
        currentGoal: instruction,
        wakeReason: {
          type: "owner_request",
          summary: instruction,
          occurredAtMs: Date.now()
        },
        controlIdempotencyKey: `managed-neoforge-decision:${randomUUID()}`,
        modelRef: decisionModelRef,
        timeoutMs: decisionTimeoutMs,
        abortSignal: controller.signal
      });
      decisionLoop = {
        modelRef: decisionModelRef,
        thinking: false,
        durationMs: decision.durationMs,
        toolCallCount: decision.toolCallCount,
        summary: decision.completion.summary,
        usage: decision.usage
      };
    } else {
      const chatText = `Mizune 真实行为联调 ${randomUUID().slice(0, 8)}`;
      const chatAccepted = await client.startBehavior({
        kind: "chat",
        text: chatText,
        channel: "global",
        guard: { controlStateToken: snapshot.controlStateToken, conditionRefs: [] },
        provenance: { contextRef: snapshot.contextRef },
        idempotencyKey: `managed-neoforge-chat:${randomUUID()}`,
        decisionReason: "验证受认证的真实聊天行为"
      }, controller.signal);
      if (!chatAccepted.ok || chatAccepted.status !== "accepted") {
        throw new Error(`真实聊天行为未被接受：${chatAccepted.reason ?? chatAccepted.status}`);
      }
    }
    const outgoingChat = await waitForNewOutgoingChat(
      client,
      previousMessageIds,
      timeoutMs,
      controller.signal
    );

    console.log(JSON.stringify({
      ok: true,
      resource: {
        resourceId,
        actorId,
        provisionStatus: ready.minecraftActor?.binding.provisionStatus,
        runtimeInstanceId: incarnation.runtimeInstanceId
      },
      snapshot: summarizeSnapshot(snapshot),
      observations: {
        environment: summarizeEnvironment(environment.value),
        inventory: summarizeInventory(inventory.value),
        players: summarizeCollection(players.value),
        entities: summarizeCollection(entities.value)
      },
      verifiedBehavior: {
        capability: "minecraft.chat.send@1",
        status: "succeeded",
        messageId: outgoingChat.messageId,
        text: outgoingChat.text
      },
      decisionLoop
    }, null, 2));
    runCompleted = true;
  } catch (error) {
    runFailure = error;
  } finally {
    if (transport) {
      try {
        await transport.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (supervisor) {
      try {
        await supervisor.stop();
      } catch (error) {
        cleanupFailures.push(error);
        logger.error({ err: error }, "minecraft_smoke_supervisor_stop_failed");
      }
    }
    if (database) {
      try {
        database.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if ((runCompleted || database === null) && cleanupFailures.length === 0) {
      await rm(dataDir, { recursive: true, force: true });
    } else {
      logger.error({ dataDir }, "minecraft_smoke_failed_state_retained");
    }
  }

  if (runFailure !== null && cleanupFailures.length > 0) {
    throw new AggregateError([runFailure, ...cleanupFailures], "真实 NeoForge smoke 与安全清理均失败");
  }
  if (runFailure !== null) throw runFailure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "真实 NeoForge smoke 安全清理失败");
  }
}

async function waitForReady(input: {
  resourceId: string;
  timeoutMs: number;
  signal: AbortSignal;
  supervisor: MinecraftRuntimeProcessSupervisor;
  registry: RuntimeResourceRegistry;
  logger: pino.Logger;
}) {
  const { resourceId, timeoutMs, signal, supervisor, registry, logger } = input;
  const deadlineAt = Date.now() + timeoutMs;
  let lastPhase = "";
  while (Date.now() < deadlineAt) {
    if (signal.aborted) throw signal.reason;
    await supervisor.reconcile();
    const resource = await registry.get(resourceId);
    const actor = resource?.minecraftActor;
    if (!resource || !actor) throw new Error(`Minecraft Actor 资源消失：${resourceId}`);
    const phase = `${actor.binding.provisionStatus}:${actor.binding.provisionPhase}`;
    if (phase !== lastPhase) {
      logger.info({ resourceId, phase }, "minecraft_smoke_provision_progress");
      lastPhase = phase;
    }
    if (actor.binding.provisionStatus === "ready") return resource;
    if (["needs_attention", "failed", "retry_wait"].includes(actor.binding.provisionStatus)) {
      const detail = actor.binding.failureMessage || actor.binding.failureCode || actor.binding.provisionStatus;
      throw new Error(`Minecraft Runtime 启动失败：${detail}`);
    }
    await delay(500, signal);
  }
  throw new Error(`等待真实 NeoForge Runtime ready 超时（${timeoutMs}ms）`);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`无效的正整数：${raw}`);
  }
  return parsed;
}

async function waitForNewOutgoingChat(
  client: ProtocolMinecraftActorClient,
  previousMessageIds: ReadonlySet<string>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (signal.aborted) throw signal.reason;
    const observed = await client.observe({ scope: "chat", limit: 100 }, signal);
    if (Array.isArray(observed.value)) {
      const match = observed.value.find(value => (
        isRecord(value)
        && value.direction === "outgoing"
        && typeof value.messageId === "string"
        && !previousMessageIds.has(value.messageId)
      ));
      if (isRecord(match)) return match;
    }
    await delay(100, signal);
  }
  throw new Error(`等待新的真实聊天行为完成超时（${timeoutMs}ms）`);
}

function collectMessageIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.flatMap(item => (
    isRecord(item) && typeof item.messageId === "string" ? [item.messageId] : []
  )));
}

function summarizeEnvironment(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const blocks = Array.isArray(value.nearbyBlocks) ? value.nearbyBlocks : [];
  const blockIds = [...new Set(blocks.flatMap(block => (
    isRecord(block) && typeof block.blockId === "string" ? [block.blockId] : []
  )))].sort();
  return {
    ...value,
    nearbyBlocks: {
      count: blocks.length,
      blockIds
    }
  };
}

function summarizeSnapshot(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.self)) return value;
  return {
    actorRevision: value.actorRevision,
    observationRevision: value.observationRevision,
    self: {
      connected: value.self.connected,
      position: value.self.position,
      health: value.self.health,
      food: value.self.food
    },
    activeBehavior: value.activeBehavior === null ? null : "present",
    activeTask: value.activeTask === null ? null : "present",
    queuedTaskCount: value.queuedTaskCount
  };
}

function summarizeInventory(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const stacks = Array.isArray(value.stacks) ? value.stacks : [];
  return {
    capacity: value.capacity,
    usedSlots: value.usedSlots,
    stacks: stacks.slice(0, 16).map(stack => {
      if (!isRecord(stack)) return "invalid";
      return {
        slot: stack.slot,
        itemId: stack.itemId,
        count: stack.count
      };
    }),
    truncated: stacks.length > 16
  };
}

function summarizeCollection(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return {
    count: value.length,
    kinds: [...new Set(value.flatMap(item => (
      isRecord(item) && typeof item.kind === "string" ? [item.kind] : []
    )))].sort()
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertClientProfileIdle(gameDirectory: string, arguments_: string[]): Promise<void> {
  const distinctiveArguments = arguments_.filter(argument => (
    argument.startsWith("/") && /\.(?:c?js|mjs|jar|py)$/u.test(argument)
  ));
  const matches: number[] = [];
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name) || Number(entry.name) === process.pid) continue;
    try {
      const commandLine = await readFile(`/proc/${entry.name}/cmdline`, "utf8");
      const matchesGameDirectory = commandLine.includes(gameDirectory);
      const matchesLauncher = distinctiveArguments.some(argument => commandLine.includes(argument));
      if (matchesGameDirectory || matchesLauncher) matches.push(Number(entry.name));
    } catch {
      // 进程可能在扫描期间退出。
    }
  }
  if (matches.length > 0) {
    throw new Error(`clientProfile 已被其他进程使用，拒绝并发启动：PID ${matches.join(", ")}`);
  }
}

async function resumeReconnectIfAuthorized(gameDirectory: string, logger: pino.Logger): Promise<void> {
  const marker = join(gameDirectory, "mizune-bridge", "reconnect-inhibited");
  let markerStat;
  try {
    markerStat = await lstat(marker);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error(`持久重连锁不是普通文件，拒绝处理：${marker}`);
  }
  if (process.env.MIZUNE_MC_SMOKE_RESUME !== "1") {
    throw new Error(
      "检测到上次安全停机留下的持久重连锁；确认本次 smoke 代表 owner 主动恢复后，设置 MIZUNE_MC_SMOKE_RESUME=1"
    );
  }
  await unlink(marker);
  logger.warn({ marker }, "minecraft_smoke_owner_resumed_reconnect");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
