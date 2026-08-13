import type { LlmClient } from "#llm/llmClient.ts";
import type {
  MinecraftActorRecoveryState,
  RuntimeResourceRecord
} from "#runtime/resources/resourceTypes.ts";
import type { RuntimeResourceRegistry } from "#runtime/resources/runtimeResourceRegistry.ts";
import type { Logger } from "pino";
import type { MinecraftActorClient } from "./actorClient.ts";
import {
  MinecraftDecisionRunner,
  type MinecraftDecisionResult,
  type MinecraftDecisionWakeReason
} from "./decisionRunner.ts";
import type { JsonValue, MinecraftActorSnapshot, MinecraftRuntimeEvent } from "./actorTypes.ts";

export type MinecraftActorWakePriority = "normal" | "high" | "critical";

export interface MinecraftActorWakeRequest extends MinecraftDecisionWakeReason {
  priority?: MinecraftActorWakePriority;
  interruptCurrent?: boolean;
}

export type MinecraftActorWakeOutcome =
  | { status: "completed"; result: MinecraftDecisionResult }
  | { status: "interrupted"; reason: string }
  | { status: "superseded"; reason: string }
  | { status: "failed"; error: string };

export interface MinecraftActorClientFactory {
  create(input: {
    resourceId: string;
    actor: MinecraftActorRecoveryState;
  }): Promise<MinecraftActorClient> | MinecraftActorClient;
}

export interface MinecraftActorOwnerNotification {
  ownerSessionId: string;
  resourceId: string;
  actorId: string;
  type: "game_attention" | "decision_failed";
  summary: string;
  details?: JsonValue;
}

export interface MinecraftActorOwnerNotificationSink {
  notify(notification: MinecraftActorOwnerNotification): Promise<void> | void;
}

export interface CreateMinecraftActorResourceInput {
  ownerSessionId: string;
  title?: string | null;
  description?: string | null;
  summary?: string;
  actor: MinecraftActorRecoveryState;
  createdAtMs?: number;
}

export interface MinecraftActorEventIngestionResult {
  events: MinecraftRuntimeEvent[];
  wake: Promise<MinecraftActorWakeOutcome> | null;
}

interface PendingWake {
  request: MinecraftActorWakeRequest;
  resolve: (outcome: MinecraftActorWakeOutcome) => void;
}

interface RunningWake {
  request: MinecraftActorWakeRequest;
  controller: AbortController;
}

interface ActorLoopState {
  running: RunningWake | null;
  pending: PendingWake | null;
}

const SIGNIFICANT_EVENT_TYPES = new Set([
  "chat_received",
  "safety_interrupt",
  "connection_changed",
  "behavior_completed",
  "task_completed",
  "task_cancelled",
  "program_failed",
  "wake_candidate"
]);

const PRIORITY_ORDER: Record<MinecraftActorWakePriority, number> = {
  normal: 0,
  high: 1,
  critical: 2
};

export class MinecraftActorResourceManager {
  private readonly clients = new Map<string, MinecraftActorClient>();
  private readonly loops = new Map<string, ActorLoopState>();
  private readonly stateUpdates = new Map<string, Promise<void>>();

  constructor(
    private readonly registry: RuntimeResourceRegistry,
    private readonly clientFactory: MinecraftActorClientFactory,
    private readonly llm: Pick<LlmClient, "generate">,
    private readonly logger: Logger,
    private readonly notificationSink?: MinecraftActorOwnerNotificationSink,
    private readonly now: () => number = Date.now
  ) {}

  async create(input: CreateMinecraftActorResourceInput): Promise<RuntimeResourceRecord> {
    validateRecoveryState(input.actor);
    const createdAtMs = input.createdAtMs ?? this.now();
    return this.registry.createMinecraftActor({
      ownerSessionId: requireNonEmpty(input.ownerSessionId, "ownerSessionId"),
      title: input.title ?? null,
      ...(input.description === undefined ? {} : { description: input.description }),
      summary: input.summary ?? buildResourceSummary(input.actor),
      createdAtMs,
      expiresAtMs: null,
      minecraftActor: cloneRecoveryState(input.actor)
    });
  }

  async list(): Promise<RuntimeResourceRecord[]> {
    return this.registry.list("minecraft_actor");
  }

  async get(resourceId: string): Promise<RuntimeResourceRecord | null> {
    const record = await this.registry.get(resourceId);
    return record?.kind === "minecraft_actor" ? record : null;
  }

  async probe(resourceId: string, signal?: AbortSignal): Promise<MinecraftActorSnapshot> {
    const record = await this.requireActiveResource(resourceId);
    const client = await this.getClient(record);
    return client.getSnapshot(signal);
  }

  wake(resourceId: string, request: MinecraftActorWakeRequest): Promise<MinecraftActorWakeOutcome> {
    validateWakeRequest(request);
    return new Promise(resolve => {
      const pending: PendingWake = { request, resolve };
      const loop = this.getLoop(resourceId);
      if (!loop.running) {
        this.startWake(resourceId, loop, pending);
        return;
      }

      const shouldInterrupt = request.interruptCurrent === true
        || priorityValue(request) > priorityValue(loop.running.request);
      if (shouldInterrupt) {
        loop.running.controller.abort(new Error(`被 ${request.type} 唤起打断`));
      }
      this.enqueuePending(loop, pending);
    });
  }

  async ingestEvents(resourceId: string): Promise<MinecraftActorEventIngestionResult> {
    const record = await this.requireActiveResource(resourceId);
    const actor = requireActorState(record);
    const client = await this.getClient(record);
    const listed = await client.listEvents(actor.lastEventSequence);
    const events = listed
      .filter(event => event.sequence > actor.lastEventSequence)
      .sort((left, right) => left.sequence - right.sequence);
    if (events.length === 0) {
      return { events: [], wake: null };
    }

    const lastSequence = events.at(-1)?.sequence ?? actor.lastEventSequence;
    await this.patchActorState(resourceId, current => ({
      ...current,
      lastEventSequence: Math.max(current.lastEventSequence, lastSequence)
    }));

    const attentionEvents = events.filter(event => event.priority === "high" || event.priority === "critical");
    if (attentionEvents.length > 0) {
      await this.notifyOwner(record, {
        type: "game_attention",
        summary: summarizeEvents(attentionEvents),
        details: { events: attentionEvents.slice(-8).map(compactRuntimeEvent) }
      });
    }

    const significant = events.filter(event =>
      event.priority === "high"
      || event.priority === "critical"
      || SIGNIFICANT_EVENT_TYPES.has(event.eventType)
    );
    if (significant.length === 0) {
      return { events, wake: null };
    }

    const occurredAtMs = significant.at(-1)?.occurredAtMs ?? this.now();
    const priority = significant.some(event => event.priority === "critical")
      ? "critical"
      : significant.some(event => event.priority === "high") ? "high" : "normal";
    return {
      events,
      wake: this.wake(resourceId, {
        type: "runtime_events",
        summary: summarizeEvents(significant),
        details: { events: significant.slice(-12).map(compactRuntimeEvent) },
        occurredAtMs,
        priority,
        interruptCurrent: priority !== "normal"
      })
    };
  }

  async notifyOwnerAttention(resourceId: string, summary: string, details?: JsonValue): Promise<void> {
    const record = await this.requireResource(resourceId);
    await this.notifyOwner(record, {
      type: "game_attention",
      summary: requireNonEmpty(summary, "summary"),
      ...(details === undefined ? {} : { details })
    });
  }

  async close(resourceId: string, reason = "closed"): Promise<void> {
    const loop = this.loops.get(resourceId);
    loop?.running?.controller.abort(new Error(reason));
    if (loop?.pending) {
      loop.pending.resolve({ status: "superseded", reason });
      loop.pending = null;
    }
    this.clients.delete(resourceId);
    await this.registry.markStatus(resourceId, "closed", this.now());
  }

  private getLoop(resourceId: string): ActorLoopState {
    const existing = this.loops.get(resourceId);
    if (existing) return existing;
    const created: ActorLoopState = { running: null, pending: null };
    this.loops.set(resourceId, created);
    return created;
  }

  private enqueuePending(loop: ActorLoopState, pending: PendingWake): void {
    if (!loop.pending) {
      loop.pending = pending;
      return;
    }
    if (priorityValue(pending.request) >= priorityValue(loop.pending.request)) {
      loop.pending.resolve({ status: "superseded", reason: `被 ${pending.request.type} 替代` });
      loop.pending = pending;
      return;
    }
    pending.resolve({ status: "superseded", reason: `已有更高优先级的 ${loop.pending.request.type}` });
  }

  private startWake(resourceId: string, loop: ActorLoopState, pending: PendingWake): void {
    const controller = new AbortController();
    loop.running = { request: pending.request, controller };
    void this.executeWake(resourceId, pending.request, controller.signal)
      .then(pending.resolve)
      .finally(() => {
        loop.running = null;
        const next = loop.pending;
        loop.pending = null;
        if (next) {
          this.startWake(resourceId, loop, next);
        } else {
          this.loops.delete(resourceId);
        }
      });
  }

  private async executeWake(
    resourceId: string,
    request: MinecraftActorWakeRequest,
    signal: AbortSignal
  ): Promise<MinecraftActorWakeOutcome> {
    try {
      const record = await this.requireActiveResource(resourceId);
      const actorState = requireActorState(record);
      const client = await this.getClient(record);
      const runner = new MinecraftDecisionRunner(this.llm, client, this.logger);
      const result = await runner.run({
        actorId: actorState.actorId,
        persistentState: actorState.persistentState,
        currentGoal: actorState.currentGoal,
        wakeReason: request,
        modelRef: actorState.modelRefs,
        allowAutonomyPolicyChange: actorState.allowAutonomyPolicyChange,
        allowProgramDeployment: actorState.allowProgramDeployment,
        abortSignal: signal
      });
      await this.patchActorState(resourceId, current => ({
        ...current,
        persistentState: result.completion.persistentState,
        currentGoal: result.completion.currentGoal
      }), result.completion.summary);
      return { status: "completed", result };
    } catch (error) {
      if (signal.aborted) {
        return { status: "interrupted", reason: abortReason(signal) };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, resourceId, wakeType: request.type }, "minecraft_actor_decision_failed");
      const record = await this.get(resourceId);
      if (record) {
        await this.notifyOwner(record, {
          type: "decision_failed",
          summary: `Minecraft 决策失败：${message}`
        });
      }
      return { status: "failed", error: message };
    }
  }

  private async getClient(record: RuntimeResourceRecord): Promise<MinecraftActorClient> {
    const cached = this.clients.get(record.resourceId);
    if (cached) return cached;
    const client = await this.clientFactory.create({
      resourceId: record.resourceId,
      actor: cloneRecoveryState(requireActorState(record))
    });
    this.clients.set(record.resourceId, client);
    return client;
  }

  private async patchActorState(
    resourceId: string,
    patch: (state: MinecraftActorRecoveryState) => MinecraftActorRecoveryState,
    summary?: string
  ): Promise<void> {
    const previous = this.stateUpdates.get(resourceId) ?? Promise.resolve();
    const update = previous.catch(() => undefined).then(async () => {
      const record = await this.requireResource(resourceId);
      const next = patch(requireActorState(record));
      validateRecoveryState(next);
      await this.registry.updateMinecraftActor(resourceId, next, {
        updatedAtMs: this.now(),
        ...(summary === undefined ? {} : { summary })
      });
    });
    this.stateUpdates.set(resourceId, update);
    try {
      await update;
    } finally {
      if (this.stateUpdates.get(resourceId) === update) {
        this.stateUpdates.delete(resourceId);
      }
    }
  }

  private async requireResource(resourceId: string): Promise<RuntimeResourceRecord> {
    const record = await this.get(requireNonEmpty(resourceId, "resourceId"));
    if (!record) throw new Error(`Minecraft Actor 资源不存在：${resourceId}`);
    requireActorState(record);
    return record;
  }

  private async requireActiveResource(resourceId: string): Promise<RuntimeResourceRecord> {
    const record = await this.requireResource(resourceId);
    if (record.status !== "active") {
      throw new Error(`Minecraft Actor 资源不是 active：${record.status}`);
    }
    return record;
  }

  private async notifyOwner(
    record: RuntimeResourceRecord,
    input: Omit<MinecraftActorOwnerNotification, "ownerSessionId" | "resourceId" | "actorId">
  ): Promise<void> {
    if (!this.notificationSink || !record.ownerSessionId) return;
    try {
      await this.notificationSink.notify({
        ownerSessionId: record.ownerSessionId,
        resourceId: record.resourceId,
        actorId: requireActorState(record).actorId,
        ...input
      });
    } catch (error) {
      this.logger.warn({ err: error, resourceId: record.resourceId }, "minecraft_actor_owner_notification_failed");
    }
  }
}

function requireActorState(record: RuntimeResourceRecord): MinecraftActorRecoveryState {
  if (record.kind !== "minecraft_actor" || !record.minecraftActor) {
    throw new Error(`资源 ${record.resourceId} 缺少 Minecraft Actor 恢复状态`);
  }
  return record.minecraftActor;
}

function validateRecoveryState(state: MinecraftActorRecoveryState): void {
  requireNonEmpty(state.actorId, "actor.actorId");
  requireNonEmpty(state.endpoint, "actor.endpoint");
  if (state.protocolVersion !== 1) throw new Error("仅支持 Minecraft Actor protocolVersion=1");
  if (state.modelRefs.length === 0 || state.modelRefs.some(model => !model.trim())) {
    throw new Error("actor.modelRefs 必须至少包含一个非空模型引用");
  }
  if (!Number.isSafeInteger(state.lastEventSequence) || state.lastEventSequence < 0) {
    throw new Error("actor.lastEventSequence 必须是非负安全整数");
  }
}

function validateWakeRequest(request: MinecraftActorWakeRequest): void {
  requireNonEmpty(request.type, "wake.type");
  requireNonEmpty(request.summary, "wake.summary");
  if (!Number.isSafeInteger(request.occurredAtMs) || request.occurredAtMs < 0) {
    throw new Error("wake.occurredAtMs 必须是非负安全整数");
  }
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} 不能为空`);
  return normalized;
}

function cloneRecoveryState(state: MinecraftActorRecoveryState): MinecraftActorRecoveryState {
  return { ...state, modelRefs: [...state.modelRefs] };
}

function buildResourceSummary(state: MinecraftActorRecoveryState): string {
  return [
    `actor=${state.actorId}`,
    `goal=${state.currentGoal ?? "none"}`,
    `transport=${state.transportKind}`,
    `event=${state.lastEventSequence}`
  ].join("；");
}

function priorityValue(request: MinecraftActorWakeRequest): number {
  return PRIORITY_ORDER[request.priority ?? "normal"];
}

function compactRuntimeEvent(event: MinecraftRuntimeEvent): JsonValue {
  return {
    sequence: event.sequence,
    eventType: event.eventType,
    priority: event.priority,
    occurredAtMs: event.occurredAtMs,
    payload: event.payload
  };
}

function summarizeEvents(events: MinecraftRuntimeEvent[]): string {
  const types = [...new Set(events.map(event => event.eventType))];
  return `收到 ${events.length} 个显著游戏事件：${types.join("、")}`;
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted");
}
