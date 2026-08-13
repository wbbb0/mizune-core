import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
import type {
  JsonValue,
  MinecraftActorSnapshot,
  MinecraftActivateProgramCommand,
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
} from "./actorTypes.ts";

export type MinecraftActorWakePriority = "normal" | "high" | "critical";

export interface MinecraftActorWakeRequest extends MinecraftDecisionWakeReason {
  priority?: MinecraftActorWakePriority;
  interruptCurrent?: boolean;
  decisionId?: string;
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
  reconcileRecoveryState?(actor: MinecraftActorRecoveryState): MinecraftActorRecoveryState;
}

export interface MinecraftActorOwnerNotification {
  notificationId: string;
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
  operation: Promise<void> | null;
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
  private readonly clients = new Map<string, Promise<MinecraftActorClient>>();
  private readonly clientsPendingCleanup = new Map<string, Promise<MinecraftActorClient>>();
  private readonly loops = new Map<string, ActorLoopState>();
  private readonly stateUpdates = new Map<string, Promise<unknown>>();
  private readonly eventIngestions = new Map<string, Promise<MinecraftActorEventIngestionResult>>();
  private readonly closeOperations = new Map<string, Promise<void>>();
  private readonly ensureOperations = new Map<string, Promise<RuntimeResourceRecord>>();
  private readonly closingResources = new Set<string>();
  private readonly outboxWakeOperations = new Map<string, Promise<MinecraftActorWakeOutcome>>();
  private readonly outboxOwnerOperations = new Map<string, Promise<void>>();
  private shuttingDown = false;
  private shutdownOperation: Promise<void> | null = null;

  constructor(
    private readonly registry: RuntimeResourceRegistry,
    private readonly clientFactory: MinecraftActorClientFactory,
    private readonly llm: Pick<LlmClient, "generate">,
    private readonly logger: Logger,
    private readonly notificationSink?: MinecraftActorOwnerNotificationSink,
    private readonly now: () => number = Date.now
  ) {}

  async create(input: CreateMinecraftActorResourceInput): Promise<RuntimeResourceRecord> {
    this.requireManagerRunning();
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

  async ensure(input: CreateMinecraftActorResourceInput): Promise<RuntimeResourceRecord> {
    this.requireManagerRunning();
    validateRecoveryState(input.actor);
    const key = `${input.actor.transportKind}\0${input.actor.endpoint}\0${input.actor.actorId}`;
    const existing = this.ensureOperations.get(key);
    if (existing) return existing;
    const operation = (async () => {
      const active = await this.registry.listActive("minecraft_actor");
      const matched = active.find(record => {
        const actor = record.minecraftActor;
        return actor?.actorId === input.actor.actorId
          && actor.transportKind === input.actor.transportKind
          && actor.endpoint === input.actor.endpoint;
      });
      return matched ? this.reconcileResourceRecord(matched) : this.create(input);
    })().finally(() => {
      if (this.ensureOperations.get(key) === operation) this.ensureOperations.delete(key);
    });
    this.ensureOperations.set(key, operation);
    return operation;
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

  async observe(
    resourceId: string,
    request: MinecraftObservationRequest,
    signal?: AbortSignal
  ): Promise<MinecraftObservationEnvelope> {
    const client = await this.requireClient(resourceId);
    return client.observe(request, signal);
  }

  async startBehavior(
    resourceId: string,
    command: MinecraftBehaviorCommand,
    signal?: AbortSignal
  ): Promise<MinecraftCommandResult> {
    const client = await this.requireClient(resourceId);
    return client.startBehavior(command, signal);
  }

  async cancelBehavior(
    resourceId: string,
    command: MinecraftCancelBehaviorCommand,
    signal?: AbortSignal
  ): Promise<MinecraftCommandResult> {
    const client = await this.requireClient(resourceId);
    return client.cancelBehavior(command, signal);
  }

  async submitTask(
    resourceId: string,
    command: MinecraftTaskCommand,
    signal?: AbortSignal
  ): Promise<MinecraftCommandResult> {
    const client = await this.requireClient(resourceId);
    return client.submitTask(command, signal);
  }

  async cancelTask(
    resourceId: string,
    command: MinecraftCancelTaskCommand,
    signal?: AbortSignal
  ): Promise<MinecraftCommandResult> {
    const client = await this.requireClient(resourceId);
    return client.cancelTask(command, signal);
  }

  async setAutonomy(
    resourceId: string,
    command: MinecraftSetAutonomyCommand,
    signal?: AbortSignal
  ): Promise<MinecraftCommandResult> {
    const record = await this.requireReconciledActiveResource(resourceId);
    if (!requireActorState(record).allowAutonomyPolicyChange) {
      throw new Error("Minecraft Actor 资源不允许修改自治策略");
    }
    const client = await this.getClient(record);
    return client.setAutonomy(command, signal);
  }

  async getActiveProgram(resourceId: string, signal?: AbortSignal): Promise<MinecraftProgramObservation> {
    const client = await this.requireClient(resourceId);
    return client.getActiveProgram(signal);
  }

  async validateProgram(
    resourceId: string,
    document: MinecraftProgramDocument,
    signal?: AbortSignal
  ): Promise<MinecraftProgramValidationResult> {
    const record = await this.requireReconciledActiveResource(resourceId);
    if (!requireActorState(record).allowProgramDeployment) {
      throw new Error("Minecraft Actor 资源不允许部署行为程序");
    }
    return (await this.getClient(record)).validateProgram(document, signal);
  }

  async activateProgram(
    resourceId: string,
    command: MinecraftActivateProgramCommand,
    signal?: AbortSignal
  ): Promise<MinecraftCommandResult> {
    const record = await this.requireReconciledActiveResource(resourceId);
    if (!requireActorState(record).allowProgramDeployment) {
      throw new Error("Minecraft Actor 资源不允许部署行为程序");
    }
    return (await this.getClient(record)).activateProgram(command, signal);
  }

  wake(resourceId: string, request: MinecraftActorWakeRequest): Promise<MinecraftActorWakeOutcome> {
    this.requireManagerRunning();
    validateWakeRequest(request);
    const normalizedRequest: MinecraftActorWakeRequest = {
      ...request,
      decisionId: request.decisionId ?? randomUUID()
    };
    return new Promise(resolve => {
      const pending: PendingWake = { request: normalizedRequest, resolve };
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
    this.requireManagerRunning();
    const normalizedResourceId = requireNonEmpty(resourceId, "resourceId");
    const existing = this.eventIngestions.get(normalizedResourceId);
    if (existing) return existing;
    const ingestion = this.ingestEventsOnce(normalizedResourceId);
    this.eventIngestions.set(normalizedResourceId, ingestion);
    try {
      return await ingestion;
    } finally {
      if (this.eventIngestions.get(normalizedResourceId) === ingestion) {
        this.eventIngestions.delete(normalizedResourceId);
      }
    }
  }

  private async ingestEventsOnce(resourceId: string): Promise<MinecraftActorEventIngestionResult> {
    const record = await this.requireActiveResource(resourceId);
    const actor = requireActorState(record);
    const client = await this.getClient(record);
    let { wake } = await this.flushEventOutbox(record);
    const listed = await client.listEvents(actor.lastEventSequence);
    const events = listed
      .filter(event => event.sequence > actor.lastEventSequence)
      .sort((left, right) => left.sequence - right.sequence);
    if (events.length === 0) {
      return { events: [], wake };
    }

    const lastSequence = events.at(-1)?.sequence ?? actor.lastEventSequence;
    const attentionEvents = events.filter(event => event.priority === "high" || event.priority === "critical");
    const significant = events.filter(event =>
      event.priority === "high"
      || event.priority === "critical"
      || SIGNIFICANT_EVENT_TYPES.has(event.eventType)
    );
    const outboxEntries: Array<{
      outboxId: string;
      eventSequence: number;
      kind: "owner_notification" | "decision_wake";
      payload: JsonValue;
    }> = [];
    if (attentionEvents.length > 0) {
      const eventSequence = attentionEvents.at(-1)?.sequence ?? lastSequence;
      outboxEntries.push({
        outboxId: `event:${eventSequence}:owner_attention`,
        eventSequence,
        kind: "owner_notification",
        payload: {
          type: "game_attention",
          summary: summarizeEvents(attentionEvents),
          details: { events: attentionEvents.slice(-8).map(compactRuntimeEvent) }
        }
      });
    }
    if (significant.length > 0) {
      const eventSequence = significant.at(-1)?.sequence ?? lastSequence;
      const occurredAtMs = significant.at(-1)?.occurredAtMs ?? this.now();
      const priority = significant.some(event => event.priority === "critical")
        ? "critical"
        : significant.some(event => event.priority === "high") ? "high" : "normal";
      outboxEntries.push({
        outboxId: `event:${eventSequence}:decision_wake`,
        eventSequence,
        kind: "decision_wake",
        payload: {
          type: "runtime_events",
          summary: summarizeEvents(significant),
          details: { events: significant.slice(-12).map(compactRuntimeEvent) },
          occurredAtMs,
          priority,
          interruptCurrent: priority !== "normal"
        }
      });
    }

    await this.enqueueStateUpdate(resourceId, async () => {
      if (this.closingResources.has(resourceId)) {
        throw new Error(`Minecraft Actor 资源正在关闭：${resourceId}`);
      }
      const recorded = await this.registry.recordMinecraftActorEvents({
        resourceId,
        lastEventSequence: lastSequence,
        entries: outboxEntries,
        updatedAtMs: this.now()
      });
      if (!recorded) throw new Error(`Minecraft Actor 资源不是 active：${resourceId}`);
    });

    const refreshed = await this.requireActiveResource(resourceId);
    const flushed = await this.flushEventOutbox(refreshed);
    wake = flushed.wake ?? wake;
    return { events, wake };
  }

  private async flushEventOutbox(
    record: RuntimeResourceRecord
  ): Promise<{ wake: Promise<MinecraftActorWakeOutcome> | null }> {
    const entries = await this.registry.listPendingMinecraftActorOutbox(record.resourceId);
    const decisionEntry = entries.find(entry => entry.kind === "decision_wake");
    let wake: Promise<MinecraftActorWakeOutcome> | null = null;
    if (decisionEntry) {
      try {
        wake = this.startOutboxWake(record.resourceId, decisionEntry.outboxId, decisionEntry.payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.registry.markMinecraftActorOutboxFailed(record.resourceId, decisionEntry.outboxId, message);
        throw error;
      }
    }
    for (const entry of entries) {
      if (entry.kind !== "owner_notification") continue;
      this.startOutboxOwnerDelivery(record, entry.outboxId, entry.payload);
    }
    return { wake };
  }

  private startOutboxOwnerDelivery(
    record: RuntimeResourceRecord,
    outboxId: string,
    payload: unknown
  ): void {
    const operationKey = `${record.resourceId}:${outboxId}`;
    if (this.outboxOwnerOperations.has(operationKey)) return;
    const operation = (async () => {
      try {
        const notification = parseOwnerNotificationPayload(payload);
        await this.deliverOwner(record, {
          notificationId: `${record.resourceId}:${outboxId}`,
          type: notification.type,
          summary: notification.summary,
          ...(notification.details === undefined ? {} : { details: notification.details })
        });
        const delivered = await this.registry.markMinecraftActorOutboxDelivered(
          record.resourceId,
          outboxId,
          this.now()
        );
        if (!delivered) {
          throw new Error(`Minecraft Actor outbox 状态已变化：${outboxId}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.registry.markMinecraftActorOutboxFailed(record.resourceId, outboxId, message);
        this.logger.warn({ err: error, resourceId: record.resourceId, outboxId }, "minecraft_actor_owner_outbox_failed");
      }
    })().finally(() => {
      if (this.outboxOwnerOperations.get(operationKey) === operation) {
        this.outboxOwnerOperations.delete(operationKey);
      }
    });
    this.outboxOwnerOperations.set(operationKey, operation);
  }

  private startOutboxWake(
    resourceId: string,
    outboxId: string,
    payload: unknown
  ): Promise<MinecraftActorWakeOutcome> {
    const operationKey = `${resourceId}:${outboxId}`;
    const existing = this.outboxWakeOperations.get(operationKey);
    if (existing) return existing;
    const operation = this.wake(resourceId, {
      ...parseWakePayload(payload),
      decisionId: outboxId
    }).then(async outcome => {
      if (outcome.status === "completed") {
        const delivered = await this.registry.markMinecraftActorOutboxDelivered(
          resourceId,
          outboxId,
          this.now()
        );
        if (!delivered) {
          throw new Error(`Minecraft Actor outbox 状态已变化：${outboxId}`);
        }
      } else {
        await this.registry.markMinecraftActorOutboxFailed(
          resourceId,
          outboxId,
          `decision_${outcome.status}`
        );
      }
      return outcome;
    }).finally(() => {
      if (this.outboxWakeOperations.get(operationKey) === operation) {
        this.outboxWakeOperations.delete(operationKey);
      }
    });
    this.outboxWakeOperations.set(operationKey, operation);
    return operation;
  }

  async notifyOwnerAttention(resourceId: string, summary: string, details?: JsonValue): Promise<void> {
    this.requireManagerRunning();
    const record = await this.requireResource(resourceId);
    await this.deliverOwner(record, {
      notificationId: `manual:${resourceId}:${this.now()}`,
      type: "game_attention",
      summary: requireNonEmpty(summary, "summary"),
      ...(details === undefined ? {} : { details })
    });
  }

  async close(resourceId: string, reason = "closed"): Promise<void> {
    this.requireManagerRunning();
    const normalizedResourceId = requireNonEmpty(resourceId, "resourceId");
    const existing = this.closeOperations.get(normalizedResourceId);
    if (existing) return existing;
    const operation = this.performClose(normalizedResourceId, reason).finally(() => {
      if (this.closeOperations.get(normalizedResourceId) === operation) {
        this.closeOperations.delete(normalizedResourceId);
      }
    });
    this.closeOperations.set(normalizedResourceId, operation);
    return operation;
  }

  async shutdown(reason = "application_shutdown"): Promise<void> {
    if (this.shutdownOperation) return this.shutdownOperation;
    this.shuttingDown = true;
    const operation = this.performShutdown(reason);
    this.shutdownOperation = operation;
    return operation;
  }

  private async performShutdown(reason: string): Promise<void> {
    for (const [resourceId, loop] of this.loops) {
      loop.running?.controller.abort(new Error(reason));
      if (loop.pending) {
        loop.pending.resolve({ status: "superseded", reason });
        loop.pending = null;
      }
      this.closingResources.add(resourceId);
    }
    for (const resourceId of this.clients.keys()) this.closingResources.add(resourceId);
    for (const resourceId of this.clientsPendingCleanup.keys()) this.closingResources.add(resourceId);
    await this.drainBackgroundOperations();
    const clients = [...new Set([
      ...this.clients.values(),
      ...this.clientsPendingCleanup.values()
    ])];
    this.clients.clear();
    this.clientsPendingCleanup.clear();
    const results = await Promise.allSettled(clients.map(async client => (await client).close()));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "关闭 Minecraft Actor 本地 transport 失败");
    }
  }

  private async drainBackgroundOperations(): Promise<void> {
    while (true) {
      const operations = [...new Set<Promise<unknown>>([
        ...this.ensureOperations.values(),
        ...this.eventIngestions.values(),
        ...this.stateUpdates.values(),
        ...this.closeOperations.values(),
        ...this.outboxWakeOperations.values(),
        ...this.outboxOwnerOperations.values(),
        ...[...this.loops.values()].flatMap(loop => loop.running?.operation ? [loop.running.operation] : [])
      ])];
      if (operations.length === 0) return;
      const results = await Promise.allSettled(operations);
      for (const result of results) {
        if (result.status === "rejected") {
          this.logger.warn({ err: result.reason }, "minecraft_actor_shutdown_operation_failed");
        }
      }
    }
  }

  private async performClose(resourceId: string, reason: string): Promise<void> {
    this.closingResources.add(resourceId);
    const loop = this.loops.get(resourceId);
    loop?.running?.controller.abort(new Error(reason));
    if (loop?.pending) {
      loop.pending.resolve({ status: "superseded", reason });
      loop.pending = null;
    }
    const client = this.clients.get(resourceId);
    this.clients.delete(resourceId);
    if (client) this.clientsPendingCleanup.set(resourceId, client);
    const closeState = this.enqueueStateUpdate(resourceId, async () => {
      await this.registry.markStatus(resourceId, "closed", this.now());
    });
    await closeState;
    const cleanupClient = this.clientsPendingCleanup.get(resourceId);
    if (cleanupClient) {
      let resolvedClient: MinecraftActorClient;
      try {
        resolvedClient = await cleanupClient;
      } catch (error) {
        if (this.clientsPendingCleanup.get(resourceId) === cleanupClient) {
          this.clientsPendingCleanup.delete(resourceId);
        }
        throw error;
      }
      await resolvedClient.close();
      if (this.clientsPendingCleanup.get(resourceId) === cleanupClient) {
        this.clientsPendingCleanup.delete(resourceId);
      }
    }
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
    const running: RunningWake = { request: pending.request, controller, operation: null };
    loop.running = running;
    const operation = this.executeWake(resourceId, pending.request, controller.signal)
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
    running.operation = operation;
  }

  private async executeWake(
    resourceId: string,
    request: MinecraftActorWakeRequest,
    signal: AbortSignal
  ): Promise<MinecraftActorWakeOutcome> {
    try {
      const record = await this.requireReconciledActiveResource(resourceId);
      const actorState = requireActorState(record);
      const client = await this.getClient(record);
      const runner = new MinecraftDecisionRunner(this.llm, client, this.logger);
      const result = await runner.run({
        actorId: actorState.actorId,
        persistentState: actorState.persistentState,
        currentGoal: actorState.currentGoal,
        wakeReason: request,
        controlIdempotencyKey: createDecisionControlIdempotencyKey(resourceId, request.decisionId),
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
        await this.notifyOwnerBestEffort(record, {
          notificationId: `decision_failed:${resourceId}:${this.now()}`,
          type: "decision_failed",
          summary: `Minecraft 决策失败：${message}`
        });
      }
      return { status: "failed", error: message };
    }
  }

  private async getClient(record: RuntimeResourceRecord): Promise<MinecraftActorClient> {
    this.requireManagerRunning();
    if (this.closingResources.has(record.resourceId)) {
      throw new Error(`Minecraft Actor 资源正在关闭：${record.resourceId}`);
    }
    const cached = this.clients.get(record.resourceId);
    if (cached) {
      const client = await cached;
      if (this.closingResources.has(record.resourceId)) {
        throw new Error(`Minecraft Actor 资源在客户端创建期间关闭：${record.resourceId}`);
      }
      return client;
    }
    const creation = Promise.resolve()
      .then(async () => {
        const reconciledRecord = await this.reconcileResourceRecord(record, true);
        return this.clientFactory.create({
          resourceId: reconciledRecord.resourceId,
          actor: cloneRecoveryState(requireActorState(reconciledRecord))
        });
      })
      .catch(error => {
        if (this.clients.get(record.resourceId) === creation) {
          this.clients.delete(record.resourceId);
        }
        throw error;
      });
    this.clients.set(record.resourceId, creation);
    const client = await creation;
    if (this.closingResources.has(record.resourceId)) {
      throw new Error(`Minecraft Actor 资源在客户端创建期间关闭：${record.resourceId}`);
    }
    return client;
  }

  private async reconcileResourceRecord(
    record: RuntimeResourceRecord,
    markUnrecoverableOnPolicyError = false
  ): Promise<RuntimeResourceRecord> {
    const reconcile = this.clientFactory.reconcileRecoveryState;
    if (!reconcile) return record;
    const current = requireActorState(record);
    let reconciled: MinecraftActorRecoveryState;
    try {
      reconciled = reconcile(cloneRecoveryState(current));
      validateRecoveryState(reconciled);
    } catch (error) {
      if (markUnrecoverableOnPolicyError) {
        await this.registry.markStatus(record.resourceId, "unrecoverable", this.now());
      }
      throw error;
    }
    if (isDeepStrictEqual(current, reconciled)) return record;
    return this.enqueueStateUpdate(record.resourceId, async () => {
      const latest = await this.requireActiveResource(record.resourceId);
      const next = reconcile(cloneRecoveryState(requireActorState(latest)));
      validateRecoveryState(next);
      const updated = await this.registry.updateMinecraftActor(record.resourceId, next, {
        updatedAtMs: this.now(),
        summary: buildResourceSummary(next)
      });
      if (!updated) throw new Error(`Minecraft Actor 资源不是 active：${record.resourceId}`);
      return updated;
    });
  }

  private async requireClient(resourceId: string): Promise<MinecraftActorClient> {
    const record = await this.requireActiveResource(resourceId);
    return this.getClient(record);
  }

  private requireManagerRunning(): void {
    if (this.shuttingDown) throw new Error("Minecraft Actor manager 正在关闭");
  }

  private async patchActorState(
    resourceId: string,
    patch: (state: MinecraftActorRecoveryState) => MinecraftActorRecoveryState,
    summary?: string
  ): Promise<void> {
    await this.enqueueStateUpdate(resourceId, async () => {
      const record = await this.requireActiveResource(resourceId);
      const next = patch(requireActorState(record));
      validateRecoveryState(next);
      const updated = await this.registry.updateMinecraftActor(resourceId, next, {
        updatedAtMs: this.now(),
        ...(summary === undefined ? {} : { summary })
      });
      if (!updated) throw new Error(`Minecraft Actor 资源不是 active：${resourceId}`);
    });
  }

  private async enqueueStateUpdate<T>(resourceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.stateUpdates.get(resourceId) ?? Promise.resolve();
    const update = previous.catch(() => undefined).then(operation);
    this.stateUpdates.set(resourceId, update);
    try {
      return await update;
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
    if (this.closingResources.has(resourceId)) {
      throw new Error(`Minecraft Actor 资源正在关闭：${resourceId}`);
    }
    const record = await this.requireResource(resourceId);
    if (record.status !== "active") {
      throw new Error(`Minecraft Actor 资源不是 active：${record.status}`);
    }
    return record;
  }

  private async requireReconciledActiveResource(resourceId: string): Promise<RuntimeResourceRecord> {
    return this.reconcileResourceRecord(await this.requireActiveResource(resourceId), true);
  }

  private async deliverOwner(
    record: RuntimeResourceRecord,
    input: Omit<MinecraftActorOwnerNotification, "ownerSessionId" | "resourceId" | "actorId">
  ): Promise<void> {
    if (!this.notificationSink) {
      throw new Error("Minecraft Actor owner notification sink 未装配");
    }
    if (!record.ownerSessionId) {
      throw new Error(`Minecraft Actor 资源缺少 owner session：${record.resourceId}`);
    }
    await this.notificationSink.notify({
      ownerSessionId: record.ownerSessionId,
      resourceId: record.resourceId,
      actorId: requireActorState(record).actorId,
      ...input
    });
  }

  private async notifyOwnerBestEffort(
    record: RuntimeResourceRecord,
    input: Omit<MinecraftActorOwnerNotification, "ownerSessionId" | "resourceId" | "actorId">
  ): Promise<void> {
    try {
      await this.deliverOwner(record, input);
    } catch (error) {
      this.logger.warn({ err: error, resourceId: record.resourceId }, "minecraft_actor_owner_notification_failed");
    }
  }
}

function parseOwnerNotificationPayload(payload: unknown): {
  type: "game_attention";
  summary: string;
  details?: JsonValue;
} {
  if (!isRecord(payload) || payload.type !== "game_attention" || typeof payload.summary !== "string") {
    throw new Error("Minecraft Actor owner notification outbox payload 无效");
  }
  return {
    type: "game_attention",
    summary: requireNonEmpty(payload.summary, "outbox.summary"),
    ...(payload.details === undefined ? {} : { details: payload.details as JsonValue })
  };
}

function parseWakePayload(payload: unknown): MinecraftActorWakeRequest {
  if (!isRecord(payload)
      || typeof payload.type !== "string"
      || typeof payload.summary !== "string"
      || typeof payload.occurredAtMs !== "number") {
    throw new Error("Minecraft Actor decision wake outbox payload 无效");
  }
  const priority = payload.priority;
  if (priority !== "normal" && priority !== "high" && priority !== "critical") {
    throw new Error("Minecraft Actor decision wake priority 无效");
  }
  return {
    type: payload.type,
    summary: payload.summary,
    occurredAtMs: payload.occurredAtMs,
    priority,
    interruptCurrent: payload.interruptCurrent === true,
    ...(payload.details === undefined ? {} : { details: payload.details as JsonValue })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (state.persistentState.length > 20_000) {
    throw new Error("actor.persistentState 不能超过 20000 字符");
  }
  if (state.currentGoal !== null && state.currentGoal.length > 500) {
    throw new Error("actor.currentGoal 不能超过 500 字符");
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
  if (request.decisionId !== undefined && (!request.decisionId.trim() || request.decisionId.length > 256)) {
    throw new Error("wake.decisionId 无效");
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
    untrustedGameData: true,
    payload: projectUntrustedGameData(event.payload)
  };
}

function projectUntrustedGameData(value: JsonValue): JsonValue {
  const budget = { nodes: 0 };
  const project = (current: JsonValue, depth: number): JsonValue => {
    budget.nodes += 1;
    if (budget.nodes > 48) return "[TRUNCATED_NODE_BUDGET]";
    if (typeof current === "string") {
      return current.length <= 240 ? current : `${current.slice(0, 239)}…`;
    }
    if (current === null || typeof current !== "object") return current;
    if (depth >= 4) return "[TRUNCATED_DEPTH]";
    if (Array.isArray(current)) {
      return current.slice(0, 12).map(item => project(item, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(current)
        .slice(0, 16)
        .map(([key, child]) => [key.slice(0, 80), project(child, depth + 1)])
    );
  };
  const projected = project(value, 0);
  const serialized = JSON.stringify(projected);
  return serialized.length <= 12_000
    ? projected
    : { truncated: true, reason: "payload_projection_budget" };
}

function summarizeEvents(events: MinecraftRuntimeEvent[]): string {
  const types = [...new Set(events.map(event => event.eventType))];
  return `收到 ${events.length} 个显著游戏事件：${types.join("、")}`.slice(0, 500);
}

function createDecisionControlIdempotencyKey(resourceId: string, decisionId: string | undefined): string {
  if (!decisionId) throw new Error("Minecraft Actor decisionId 缺失");
  return `decision:${createHash("sha256").update(`${resourceId}\0${decisionId}`, "utf8").digest("hex")}`;
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted");
}
