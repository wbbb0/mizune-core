import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LlmClient } from "../../src/llm/llmClient.ts";
import type {
  LlmGenerateParams,
  LlmGenerateResult,
  LlmToolCall,
  LlmUsage
} from "../../src/llm/provider/providerTypes.ts";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { RuntimeResourceRegistry } from "../../src/runtime/resources/runtimeResourceRegistry.ts";
import { RuntimeResourceStore } from "../../src/runtime/resources/runtimeResourceStore.ts";
import type { MinecraftActorClient } from "../../src/services/minecraft/actorClient.ts";
import {
  MinecraftActorResourceManager,
  type MinecraftActorOwnerNotification,
  type MinecraftActorOwnerNotificationSink
} from "../../src/services/minecraft/actorResourceManager.ts";
import type {
  MinecraftActivateProgramCommand,
  MinecraftActorSnapshot,
  MinecraftBehaviorCommand,
  MinecraftCancelBehaviorCommand,
  MinecraftCancelTaskCommand,
  MinecraftCommandResult,
  MinecraftObservationEnvelope,
  MinecraftObservationRequest,
  MinecraftProgramDocument,
  MinecraftProgramObservation,
  MinecraftProgramValidationResult,
  MinecraftRuntimeEvent,
  MinecraftSetAutonomyCommand,
  MinecraftTaskCommand
} from "../../src/services/minecraft/actorTypes.ts";
import { createSilentLogger } from "../helpers/browser-test-support.tsx";

type Generate = LlmClient["generate"];

class ResourceActorClient implements MinecraftActorClient {
  events: MinecraftRuntimeEvent[] = [];
  closeCalls = 0;
  listEventsCalls = 0;

  async getSnapshot(): Promise<MinecraftActorSnapshot> {
    return actorSnapshot();
  }

  async observe(_request: MinecraftObservationRequest): Promise<MinecraftObservationEnvelope> {
    return observation(null);
  }

  async startBehavior(_command: MinecraftBehaviorCommand): Promise<MinecraftCommandResult> {
    return commandResult();
  }

  async cancelBehavior(_command: MinecraftCancelBehaviorCommand): Promise<MinecraftCommandResult> {
    return commandResult();
  }

  async submitTask(_command: MinecraftTaskCommand): Promise<MinecraftCommandResult> {
    return commandResult();
  }

  async cancelTask(_command: MinecraftCancelTaskCommand): Promise<MinecraftCommandResult> {
    return commandResult();
  }

  async setAutonomy(_command: MinecraftSetAutonomyCommand): Promise<MinecraftCommandResult> {
    return commandResult();
  }

  async getActiveProgram(): Promise<MinecraftProgramObservation> {
    return { ...observation(null), value: null };
  }

  async validateProgram(document: MinecraftProgramDocument): Promise<MinecraftProgramValidationResult> {
    return {
      protocolVersion: 1,
      ok: true,
      draft: { draftId: "draft-1", validatedAtMs: 1, program: document },
      diagnostics: []
    };
  }

  async activateProgram(_command: MinecraftActivateProgramCommand): Promise<MinecraftCommandResult> {
    return commandResult();
  }

  async listEvents(afterSequence = 0): Promise<MinecraftRuntimeEvent[]> {
    this.listEventsCalls += 1;
    return this.events.filter(event => event.sequence > afterSequence);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

test("actor resource manager persists completed decision state", async () => {
  const harness = await createManagerHarness(new FinishOnlyLlm("完成巡逻", "已检查出生点", "维护出生点"));
  try {
    const resource = await harness.manager.create(resourceInput());
    const snapshot = await harness.manager.probe(resource.resourceId);
    const outcome = await harness.manager.wake(resource.resourceId, {
      type: "idle_opportunity",
      summary: "空闲十秒",
      occurredAtMs: 100
    });
    const persisted = await harness.registry.get(resource.resourceId);

    assert.equal(snapshot.actorId, "actor-1");
    assert.equal(outcome.status, "completed");
    assert.equal(persisted?.minecraftActor?.persistentState, "已检查出生点");
    assert.equal(persisted?.minecraftActor?.currentGoal, "维护出生点");
    assert.equal(persisted?.summary, "完成巡逻");
    assert.equal(harness.factoryCalls, 1);
  } finally {
    await harness.close();
  }
});

test("critical wake interrupts current decision and runs next wake", async () => {
  let generation = 0;
  const llm: Pick<LlmClient, "generate"> = {
    generate: async params => {
      generation += 1;
      if (generation === 1) {
        await waitForAbort(params.abortSignal);
      }
      await finishDecision(params, "处理紧急事件", "已脱离危险", null);
      return llmResult();
    }
  };
  const harness = await createManagerHarness(llm);
  try {
    const resource = await harness.manager.create(resourceInput());
    const first = harness.manager.wake(resource.resourceId, {
      type: "idle_opportunity",
      summary: "空闲",
      occurredAtMs: 100
    });
    const second = harness.manager.wake(resource.resourceId, {
      type: "safety_interrupt",
      summary: "掉入岩浆",
      occurredAtMs: 101,
      priority: "critical",
      interruptCurrent: true
    });

    assert.equal((await first).status, "interrupted");
    assert.equal((await second).status, "completed");
    assert.equal(generation, 2);
  } finally {
    await harness.close();
  }
});

test("event ingestion advances cursor, wakes decision loop and notifies owner", async () => {
  const notifications: MinecraftActorOwnerNotification[] = [];
  const harness = await createManagerHarness(
    new FinishOnlyLlm("处理安全事件", "已停手并等待", null),
    notifications
  );
  try {
    const resource = await harness.manager.create(resourceInput());
    harness.client.events = [runtimeEvent({
      sequence: 8,
      eventType: "safety_interrupt",
      priority: "critical",
      payload: { reason: "lava" }
    })];

    const ingested = await harness.manager.ingestEvents(resource.resourceId);
    const outcome = await ingested.wake;
    const persisted = await harness.registry.get(resource.resourceId);

    assert.equal(outcome?.status, "completed");
    assert.equal(persisted?.minecraftActor?.lastEventSequence, 8);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.ownerSessionId, "onebot:private:owner");
    assert.equal(notifications[0]?.type, "game_attention");
  } finally {
    await harness.close();
  }
});

test("concurrent event ingestion is single-flight", async () => {
  const notifications: MinecraftActorOwnerNotification[] = [];
  const harness = await createManagerHarness(
    new FinishOnlyLlm("处理安全事件", "已处理", null),
    notifications
  );
  try {
    const resource = await harness.manager.create(resourceInput());
    harness.client.events = [runtimeEvent({ sequence: 8, priority: "critical" })];

    const [first, second] = await Promise.all([
      harness.manager.ingestEvents(resource.resourceId),
      harness.manager.ingestEvents(resource.resourceId)
    ]);
    await Promise.all([first.wake, second.wake]);

    assert.equal(harness.client.listEventsCalls, 1);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.notificationId, `${resource.resourceId}:event:8:owner_attention`);
  } finally {
    await harness.close();
  }
});

test("failed owner notification remains in outbox and retries after cursor advance", async () => {
  const notifications: MinecraftActorOwnerNotification[] = [];
  const attemptedIds: string[] = [];
  let attempts = 0;
  const notificationSink: MinecraftActorOwnerNotificationSink = {
    notify(notification) {
      attempts += 1;
      attemptedIds.push(notification.notificationId);
      if (attempts === 1) throw new Error("temporary notification failure");
      notifications.push(notification);
    }
  };
  const harness = await createManagerHarness(
    new FinishOnlyLlm("处理安全事件", "已处理", null),
    notifications,
    notificationSink
  );
  try {
    const resource = await harness.manager.create(resourceInput());
    harness.client.events = [runtimeEvent({ sequence: 8, priority: "critical" })];

    await assert.rejects(harness.manager.ingestEvents(resource.resourceId), /temporary notification failure/);
    assert.equal((await harness.registry.get(resource.resourceId))?.minecraftActor?.lastEventSequence, 8);

    const retried = await harness.manager.ingestEvents(resource.resourceId);
    assert.equal((await retried.wake)?.status, "completed");
    assert.equal(attempts, 2);
    assert.equal(notifications.length, 1);
    assert.equal(attemptedIds[0], attemptedIds[1]);
  } finally {
    await harness.close();
  }
});

test("client creation is single-flight and close disposes a client created during shutdown", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-minecraft-actor-close-"));
  const database = new StateDatabase(dataDir, createSilentLogger());
  const registry = new RuntimeResourceRegistry(new RuntimeResourceStore(database));
  const client = new ResourceActorClient();
  const clientReady = deferred<ResourceActorClient>();
  let factoryCalls = 0;
  const manager = new MinecraftActorResourceManager(
    registry,
    {
      create() {
        factoryCalls += 1;
        return clientReady.promise;
      }
    },
    new FinishOnlyLlm("完成", "完成", null),
    createSilentLogger()
  );
  try {
    const resource = await manager.create(resourceInput());
    const firstProbe = manager.probe(resource.resourceId);
    const secondProbe = manager.probe(resource.resourceId);
    await waitUntil(() => factoryCalls === 1);

    const close = manager.close(resource.resourceId, "测试关闭");
    clientReady.resolve(client);
    const probes = await Promise.allSettled([firstProbe, secondProbe]);
    await close;

    assert.equal(factoryCalls, 1);
    assert.equal(client.closeCalls, 1);
    assert.ok(probes.every(result => result.status === "rejected"));
    assert.equal((await registry.get(resource.resourceId))?.status, "closed");
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("close remains irreversible when an aborted provider finishes late", async () => {
  const generationStarted = deferred<void>();
  const releaseGeneration = deferred<void>();
  const llm: Pick<LlmClient, "generate"> = {
    generate: async params => {
      generationStarted.resolve(undefined);
      await releaseGeneration.promise;
      await finishDecision(params, "迟到完成", "不应持久化", "不应恢复");
      return llmResult();
    }
  };
  const harness = await createManagerHarness(llm);
  try {
    const resource = await harness.manager.create(resourceInput());
    const wake = harness.manager.wake(resource.resourceId, {
      type: "idle_opportunity",
      summary: "空闲",
      occurredAtMs: 100
    });
    await generationStarted.promise;
    await harness.manager.close(resource.resourceId, "owner closed");
    releaseGeneration.resolve(undefined);

    assert.equal((await wake).status, "interrupted");
    await delay(10);
    const persisted = await harness.registry.get(resource.resourceId);
    assert.equal(persisted?.status, "closed");
    assert.equal(persisted?.minecraftActor?.persistentState, "在出生点待命");
  } finally {
    await harness.close();
  }
});

class FinishOnlyLlm {
  constructor(
    private readonly summary: string,
    private readonly persistentState: string,
    private readonly currentGoal: string | null
  ) {}

  generate: Generate = async params => {
    await finishDecision(params, this.summary, this.persistentState, this.currentGoal);
    return llmResult();
  };
}

async function createManagerHarness(
  llm: Pick<LlmClient, "generate">,
  notifications: MinecraftActorOwnerNotification[] = [],
  notificationSink: MinecraftActorOwnerNotificationSink = {
    notify(notification) { notifications.push(notification); }
  }
) {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-minecraft-actor-manager-"));
  const database = new StateDatabase(dataDir, createSilentLogger());
  const store = new RuntimeResourceStore(database);
  const registry = new RuntimeResourceRegistry(store);
  const client = new ResourceActorClient();
  let factoryCalls = 0;
  const manager = new MinecraftActorResourceManager(
    registry,
    {
      create() {
        factoryCalls += 1;
        return client;
      }
    },
    llm,
    createSilentLogger(),
    notificationSink,
    () => 1_000
  );
  return {
    manager,
    registry,
    client,
    get factoryCalls() { return factoryCalls; },
    async close() {
      database.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await delay(1);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resourceInput() {
  return {
    ownerSessionId: "onebot:private:owner",
    title: "Mizune MC",
    actor: {
      actorId: "actor-1",
      transportKind: "in_process" as const,
      endpoint: "simulation:actor-1",
      protocolVersion: 1 as const,
      persistentState: "在出生点待命",
      currentGoal: "巡逻",
      modelRefs: ["prod_deepseek.v4_flash"],
      allowAutonomyPolicyChange: false,
      allowProgramDeployment: false,
      lastEventSequence: 0
    }
  };
}

async function finishDecision(
  params: LlmGenerateParams,
  summary: string,
  persistentState: string,
  currentGoal: string | null
): Promise<void> {
  const call: LlmToolCall = {
    id: "finish-1",
    type: "function",
    function: {
      name: "minecraft_finish_decision",
      arguments: JSON.stringify({ summary, persistentState, currentGoal })
    }
  };
  await params.onAssistantToolCalls?.({ role: "assistant", content: "", tool_calls: [call] });
  await params.toolExecutor?.(call);
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) throw new Error("missing abort signal");
  if (signal.aborted) throw signal.reason;
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function actorSnapshot(): MinecraftActorSnapshot {
  return {
    protocolVersion: 1,
    actorId: "actor-1",
    actorRevision: 3,
    observationRevision: 7,
    self: selfState(),
    activeBehavior: null,
    actionLease: null,
    activeTask: null,
    queuedTaskCount: 0,
    autonomyPolicy: {
      enabled: false,
      idleDelayMs: 10_000,
      collectItems: true,
      explore: true,
      combatHostiles: false,
      exploreRadius: 12,
      combatStopHealth: 8
    }
  };
}

function observation(value: MinecraftObservationEnvelope["value"]): MinecraftObservationEnvelope {
  return {
    protocolVersion: 1,
    actorId: "actor-1",
    actorRevision: 3,
    observationRevision: 7,
    observedAtMs: 100,
    self: selfState(),
    value
  };
}

function commandResult(): MinecraftCommandResult {
  return {
    protocolVersion: 1,
    commandId: "command-1",
    idempotencyKey: "key-1",
    ok: true,
    status: "accepted",
    reason: null,
    retryability: "none",
    actorRevision: 4,
    observationRevision: 7,
    value: {}
  };
}

function runtimeEvent(overrides: Partial<MinecraftRuntimeEvent> = {}): MinecraftRuntimeEvent {
  return {
    protocolVersion: 1,
    eventId: "event-1",
    sequence: 1,
    actorId: "actor-1",
    eventType: "behavior_completed",
    priority: "normal",
    occurredAtMs: 100,
    actorRevision: 4,
    observationRevision: 7,
    payload: {},
    ...overrides
  };
}

function selfState() {
  return {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    connected: true
  };
}

function llmResult(): LlmGenerateResult {
  return { text: "done", reasoningContent: "", usage: usage(), providerCallUsages: [] };
}

function usage(): LlmUsage {
  return {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cachedTokens: 80,
    reasoningTokens: 0,
    requestCount: 1,
    providerReported: true,
    modelRef: "prod_deepseek.v4_flash",
    model: "deepseek-v4-flash"
  };
}
