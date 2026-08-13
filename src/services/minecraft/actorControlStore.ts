import { createHash, randomUUID } from "node:crypto";
import type { StateDatabase } from "#data/state/stateDatabase.ts";
import type { SqliteDatabase } from "#data/sqlite/sqliteService.ts";
import type { JsonValue } from "./actorTypes.ts";

export type MinecraftActorLoopPhase = "idle" | "queued" | "deciding" | "paused" | "error" | "closed";
export type MinecraftActorRequestPriority = "normal" | "high";
export type MinecraftActorRequestStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";
export type MinecraftActorWakePriority = "normal" | "high" | "critical";
export type MinecraftActorWakeSource = "owner_request" | "runtime_event" | "manual" | "autonomy";
export type MinecraftActorWakeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "dead_letter";
export type MinecraftActorDecisionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "dead_letter";

export interface MinecraftActorControlState {
  resourceId: string;
  ownerPrincipalId: string;
  revision: number;
  loopPhase: MinecraftActorLoopPhase;
  activeWakeId: string | null;
  activeDecisionId: string | null;
  lastError: string | null;
  updatedAtMs: number;
}

export interface MinecraftActorRequestRecord {
  resourceId: string;
  requestId: string;
  idempotencyKey: string;
  ownerPrincipalId: string;
  ownerSessionId: string;
  instruction: string;
  constraints: string | null;
  priority: MinecraftActorRequestPriority;
  status: MinecraftActorRequestStatus;
  decisionId: string | null;
  resultSummary: string | null;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

export interface MinecraftActorWakeRecord {
  resourceId: string;
  wakeId: string;
  sourceType: MinecraftActorWakeSource;
  sourceId: string;
  priority: MinecraftActorWakePriority;
  wakeType: string;
  summary: string;
  details: JsonValue | null;
  status: MinecraftActorWakeStatus;
  decisionId: string;
  attemptCount: number;
  nextAttemptAtMs: number;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
}

export interface MinecraftActorDecisionRecord {
  resourceId: string;
  decisionId: string;
  wakeId: string;
  requestId: string | null;
  status: MinecraftActorDecisionStatus;
  attemptCount: number;
  wakeType: string;
  wakeSummary: string;
  decisionSummary: string | null;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

export interface MinecraftActorJournalEvent {
  eventId: number;
  resourceId: string;
  eventType: string;
  severity: "debug" | "info" | "warning" | "critical";
  actorRevision: number;
  requestId: string | null;
  decisionId: string | null;
  payload: JsonValue;
  occurredAtMs: number;
}

export interface ClaimedMinecraftActorWake {
  state: MinecraftActorControlState;
  wake: MinecraftActorWakeRecord;
  decision: MinecraftActorDecisionRecord;
  request: MinecraftActorRequestRecord | null;
}

export class MinecraftActorRevisionConflictError extends Error {
  readonly statusCode = 409;

  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Minecraft Actor revision 冲突：期望 ${expectedRevision}，实际 ${actualRevision}`);
    this.name = "MinecraftActorRevisionConflictError";
  }
}

export class MinecraftActorIdempotencyConflictError extends Error {
  readonly statusCode = 409;

  constructor(readonly idempotencyKey: string) {
    super(`Minecraft Actor 幂等键参数冲突：${idempotencyKey}`);
    this.name = "MinecraftActorIdempotencyConflictError";
  }
}

type JournalListener = (event: MinecraftActorJournalEvent) => void;

export class MinecraftActorControlStore {
  private readonly listeners = new Set<JournalListener>();

  constructor(private readonly stateDatabase: StateDatabase) {}

  subscribe(listener: JournalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initializeActor(input: {
    resourceId: string;
    ownerPrincipalId: string;
    ownerSessionId: string;
    nowMs: number;
  }): Promise<MinecraftActorControlState> {
    const db = await this.getDb();
    const normalized = {
      resourceId: requireText(input.resourceId, "resourceId", 256),
      ownerPrincipalId: requireText(input.ownerPrincipalId, "ownerPrincipalId", 256),
      ownerSessionId: requireText(input.ownerSessionId, "ownerSessionId", 512),
      nowMs: requireTimestamp(input.nowMs, "nowMs")
    };
    const initialize = db.transaction(() => {
      const resource = db.prepare(`
        SELECT owner_session_id AS ownerSessionId
        FROM runtime_resources
        WHERE resource_id = ? AND kind = 'minecraft_actor' AND status = 'active'
      `).get(normalized.resourceId) as { ownerSessionId: string | null } | undefined;
      if (!resource) throw new Error(`Minecraft Actor 资源不是 active：${normalized.resourceId}`);
      const existing = getControlStateSync(db, normalized.resourceId);
      if (existing && existing.ownerPrincipalId !== normalized.ownerPrincipalId) {
        const isLegacyPlaceholder = existing.ownerPrincipalId === resource.ownerSessionId;
        if (!isLegacyPlaceholder) {
          throw new Error(`Minecraft Actor 已属于其他主体：${normalized.resourceId}`);
        }
      }
      db.prepare(`
        INSERT INTO minecraft_actor_control_state (
          resource_id, owner_principal_id, revision, loop_phase, updated_at_ms
        ) VALUES (@resourceId, @ownerPrincipalId, 0, 'idle', @nowMs)
        ON CONFLICT(resource_id) DO UPDATE SET
          owner_principal_id = excluded.owner_principal_id,
          updated_at_ms = MAX(minecraft_actor_control_state.updated_at_ms, excluded.updated_at_ms)
      `).run(normalized);
      return requireControlStateSync(db, normalized.resourceId);
    });
    return initialize();
  }

  async getControlState(resourceId: string): Promise<MinecraftActorControlState | null> {
    return getControlStateSync(await this.getDb(), requireText(resourceId, "resourceId", 256));
  }

  async requireOwnerRevision(input: {
    resourceId: string;
    ownerPrincipalId: string;
    expectedRevision?: number;
  }): Promise<MinecraftActorControlState> {
    const db = await this.getDb();
    const state = requireControlStateSync(db, requireText(input.resourceId, "resourceId", 256));
    requireOwner(state, requireText(input.ownerPrincipalId, "ownerPrincipalId", 256));
    requireExpectedRevision(
      state,
      input.expectedRevision === undefined
        ? undefined
        : requireNonNegativeInteger(input.expectedRevision, "expectedRevision")
    );
    return state;
  }

  async enqueueRequest(input: {
    resourceId: string;
    requestId?: string;
    idempotencyKey: string;
    ownerPrincipalId: string;
    ownerSessionId: string;
    instruction: string;
    constraints?: string | null;
    priority?: MinecraftActorRequestPriority;
    expectedRevision?: number;
    nowMs: number;
  }): Promise<{ request: MinecraftActorRequestRecord; state: MinecraftActorControlState; replayed: boolean }> {
    const db = await this.getDb();
    const normalized = normalizeRequestInput(input);
    const fingerprint = requestFingerprint(normalized);
    const appendedEvents: MinecraftActorJournalEvent[] = [];
    const enqueue = db.transaction(() => {
      const existingRow = db.prepare(`
        SELECT * FROM minecraft_actor_requests
        WHERE resource_id = ? AND idempotency_key = ?
      `).get(normalized.resourceId, normalized.idempotencyKey) as RequestRow | undefined;
      if (existingRow) {
        if (existingRow.fingerprint !== fingerprint) {
          throw new MinecraftActorIdempotencyConflictError(normalized.idempotencyKey);
        }
        return {
          request: mapRequestRow(existingRow),
          state: requireControlStateSync(db, normalized.resourceId),
          replayed: true
        };
      }

      const state = requireControlStateSync(db, normalized.resourceId);
      requireOwner(state, normalized.ownerPrincipalId);
      requireExpectedRevision(state, normalized.expectedRevision);
      const requestId = normalized.requestId ?? `mc_req_${randomUUID().replaceAll("-", "")}`;
      const wakeId = `request:${requestId}`;
      const decisionId = `mc_dec_${randomUUID().replaceAll("-", "")}`;
      const wakeDetails = {
        requestId,
        instruction: normalized.instruction,
        constraints: normalized.constraints,
        ownerPrincipalId: normalized.ownerPrincipalId
      };
      const wakeFingerprint = createFingerprint({
        wakeId,
        sourceType: "owner_request",
        sourceId: requestId,
        priority: normalized.priority,
        wakeType: "owner_request",
        summary: normalized.instruction,
        details: wakeDetails
      });
      const nextRevision = state.revision + 1;
      db.prepare(`
        INSERT INTO minecraft_actor_requests (
          resource_id, request_id, idempotency_key, fingerprint,
          owner_principal_id, owner_session_id, instruction, constraints_text,
          priority, status, created_at_ms, updated_at_ms
        ) VALUES (
          @resourceId, @requestId, @idempotencyKey, @fingerprint,
          @ownerPrincipalId, @ownerSessionId, @instruction, @constraints,
          @priority, 'queued', @nowMs, @nowMs
        )
      `).run({ ...normalized, requestId, fingerprint });
      db.prepare(`
        INSERT INTO minecraft_actor_wake_mailbox (
          resource_id, wake_id, source_type, source_id, fingerprint, priority, wake_type,
          summary, details_json, status, decision_id, next_attempt_at_ms,
          created_at_ms, updated_at_ms
        ) VALUES (
          @resourceId, @wakeId, 'owner_request', @requestId, @wakeFingerprint, @priority, 'owner_request',
          @instruction, @detailsJson, 'pending', @decisionId, @nowMs,
          @nowMs, @nowMs
        )
      `).run({
        ...normalized,
        requestId,
        wakeId,
        decisionId,
        wakeFingerprint,
        detailsJson: JSON.stringify(wakeDetails)
      });
      updateControlStateSync(db, normalized.resourceId, {
        revision: nextRevision,
        loopPhase: "queued",
        activeWakeId: null,
        activeDecisionId: null,
        lastError: null,
        updatedAtMs: normalized.nowMs
      });
      appendedEvents.push(appendEventSync(db, {
        resourceId: normalized.resourceId,
        eventType: "owner_request_queued",
        severity: "info",
        actorRevision: nextRevision,
        requestId,
        decisionId,
        payload: {
          requestId,
          instruction: normalized.instruction,
          constraints: normalized.constraints,
          priority: normalized.priority
        },
        occurredAtMs: normalized.nowMs
      }));
      return {
        request: requireRequestSync(db, normalized.resourceId, requestId),
        state: requireControlStateSync(db, normalized.resourceId),
        replayed: false
      };
    });
    const result = enqueue();
    this.publish(appendedEvents);
    return result;
  }

  async enqueueWake(input: {
    resourceId: string;
    wakeId: string;
    sourceType: Exclude<MinecraftActorWakeSource, "owner_request">;
    sourceId: string;
    priority: MinecraftActorWakePriority;
    wakeType: string;
    summary: string;
    details?: JsonValue;
    nowMs: number;
  }): Promise<{ wake: MinecraftActorWakeRecord; replayed: boolean }> {
    const db = await this.getDb();
    const normalized = {
      resourceId: requireText(input.resourceId, "resourceId", 256),
      wakeId: requireText(input.wakeId, "wakeId", 512),
      sourceType: input.sourceType,
      sourceId: requireText(input.sourceId, "sourceId", 512),
      priority: input.priority,
      wakeType: requireText(input.wakeType, "wakeType", 128),
      summary: requireText(input.summary, "summary", 4_000),
      details: input.details ?? null,
      nowMs: requireTimestamp(input.nowMs, "nowMs")
    };
    const fingerprint = createFingerprint({
      wakeId: normalized.wakeId,
      sourceType: normalized.sourceType,
      sourceId: normalized.sourceId,
      priority: normalized.priority,
      wakeType: normalized.wakeType,
      summary: normalized.summary,
      details: normalized.details
    });
    const appendedEvents: MinecraftActorJournalEvent[] = [];
    const enqueue = db.transaction(() => {
      const existing = db.prepare(`
        SELECT * FROM minecraft_actor_wake_mailbox
        WHERE resource_id = ? AND source_type = ? AND source_id = ?
      `).get(normalized.resourceId, normalized.sourceType, normalized.sourceId) as WakeRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new MinecraftActorIdempotencyConflictError(`${normalized.sourceType}:${normalized.sourceId}`);
        }
        return { wake: mapWakeRow(existing), replayed: true };
      }
      const state = requireControlStateSync(db, normalized.resourceId);
      const nextRevision = state.revision + 1;
      const decisionId = `mc_dec_${randomUUID().replaceAll("-", "")}`;
      db.prepare(`
        INSERT INTO minecraft_actor_wake_mailbox (
          resource_id, wake_id, source_type, source_id, fingerprint, priority, wake_type,
          summary, details_json, status, decision_id, next_attempt_at_ms,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        normalized.resourceId,
        normalized.wakeId,
        normalized.sourceType,
        normalized.sourceId,
        fingerprint,
        normalized.priority,
        normalized.wakeType,
        normalized.summary,
        normalized.details === null ? null : JSON.stringify(normalized.details),
        decisionId,
        normalized.nowMs,
        normalized.nowMs,
        normalized.nowMs
      );
      updateControlStateSync(db, normalized.resourceId, {
        revision: nextRevision,
        loopPhase: "queued",
        activeWakeId: state.activeWakeId,
        activeDecisionId: state.activeDecisionId,
        lastError: state.lastError,
        updatedAtMs: normalized.nowMs
      });
      appendedEvents.push(appendEventSync(db, {
        resourceId: normalized.resourceId,
        eventType: "wake_queued",
        severity: normalized.priority === "critical" ? "critical" : "info",
        actorRevision: nextRevision,
        requestId: null,
        decisionId,
        payload: {
          wakeId: normalized.wakeId,
          sourceType: normalized.sourceType,
          wakeType: normalized.wakeType,
          summary: normalized.summary,
          priority: normalized.priority
        },
        occurredAtMs: normalized.nowMs
      }));
      return {
        wake: requireWakeSync(db, normalized.resourceId, normalized.wakeId),
        replayed: false
      };
    });
    const result = enqueue();
    this.publish(appendedEvents);
    return result;
  }

  async claimNextWake(resourceId: string, nowMs: number): Promise<ClaimedMinecraftActorWake | null> {
    const db = await this.getDb();
    const normalizedResourceId = requireText(resourceId, "resourceId", 256);
    const normalizedNow = requireTimestamp(nowMs, "nowMs");
    const appendedEvents: MinecraftActorJournalEvent[] = [];
    const claim = db.transaction(() => {
      const state = requireControlStateSync(db, normalizedResourceId);
      if (state.loopPhase === "paused" || state.loopPhase === "closed" || state.activeWakeId) return null;
      const wakeRow = db.prepare(`
        SELECT * FROM minecraft_actor_wake_mailbox
        WHERE resource_id = ? AND status = 'pending' AND next_attempt_at_ms <= ?
        ORDER BY
          CASE priority WHEN 'critical' THEN 2 WHEN 'high' THEN 1 ELSE 0 END DESC,
          created_at_ms ASC,
          rowid ASC
        LIMIT 1
      `).get(normalizedResourceId, normalizedNow) as WakeRow | undefined;
      if (!wakeRow) {
        const hasPending = db.prepare(`
          SELECT 1 FROM minecraft_actor_wake_mailbox
          WHERE resource_id = ? AND status = 'pending'
          LIMIT 1
        `).get(normalizedResourceId) !== undefined;
        if (hasPending) return null;
        if (state.loopPhase !== "idle") {
          updateControlStateSync(db, normalizedResourceId, {
            revision: state.revision + 1,
            loopPhase: "idle",
            activeWakeId: null,
            activeDecisionId: null,
            lastError: state.lastError,
            updatedAtMs: normalizedNow
          });
        }
        return null;
      }
      const wake = mapWakeRow(wakeRow);
      const requestId = wake.sourceType === "owner_request" ? wake.sourceId : null;
      const nextRevision = state.revision + 1;
      db.prepare(`
        UPDATE minecraft_actor_wake_mailbox
        SET status = 'running', attempt_count = attempt_count + 1,
            updated_at_ms = ?, last_error = NULL
        WHERE resource_id = ? AND wake_id = ? AND status = 'pending'
      `).run(normalizedNow, normalizedResourceId, wake.wakeId);
      if (requestId) {
        db.prepare(`
          UPDATE minecraft_actor_requests
          SET status = 'running', decision_id = ?, updated_at_ms = ?,
              started_at_ms = COALESCE(started_at_ms, ?), error = NULL
          WHERE resource_id = ? AND request_id = ? AND status IN ('queued', 'running')
        `).run(wake.decisionId, normalizedNow, normalizedNow, normalizedResourceId, requestId);
      }
      db.prepare(`
        INSERT INTO minecraft_actor_decisions (
          resource_id, decision_id, wake_id, request_id, status, attempt_count,
          wake_type, wake_summary, created_at_ms, updated_at_ms, started_at_ms
        ) VALUES (?, ?, ?, ?, 'running', 1, ?, ?, ?, ?, ?)
        ON CONFLICT(resource_id, decision_id) DO UPDATE SET
          status = 'running',
          attempt_count = minecraft_actor_decisions.attempt_count + 1,
          updated_at_ms = excluded.updated_at_ms,
          started_at_ms = COALESCE(minecraft_actor_decisions.started_at_ms, excluded.started_at_ms),
          error = NULL,
          completed_at_ms = NULL
      `).run(
        normalizedResourceId,
        wake.decisionId,
        wake.wakeId,
        requestId,
        wake.wakeType,
        wake.summary,
        normalizedNow,
        normalizedNow,
        normalizedNow
      );
      updateControlStateSync(db, normalizedResourceId, {
        revision: nextRevision,
        loopPhase: "deciding",
        activeWakeId: wake.wakeId,
        activeDecisionId: wake.decisionId,
        lastError: null,
        updatedAtMs: normalizedNow
      });
      appendedEvents.push(appendEventSync(db, {
        resourceId: normalizedResourceId,
        eventType: "decision_started",
        severity: "info",
        actorRevision: nextRevision,
        requestId,
        decisionId: wake.decisionId,
        payload: { wakeId: wake.wakeId, wakeType: wake.wakeType, attempt: wake.attemptCount + 1 },
        occurredAtMs: normalizedNow
      }));
      return {
        state: requireControlStateSync(db, normalizedResourceId),
        wake: requireWakeSync(db, normalizedResourceId, wake.wakeId),
        decision: requireDecisionSync(db, normalizedResourceId, wake.decisionId),
        request: requestId ? requireRequestSync(db, normalizedResourceId, requestId) : null
      };
    });
    const result = claim();
    this.publish(appendedEvents);
    return result;
  }

  async completeDecision(input: {
    resourceId: string;
    wakeId: string;
    decisionId: string;
    status: "completed" | "failed" | "interrupted" | "dead_letter";
    summary?: string | null;
    error?: string | null;
    persistentState?: string;
    currentGoal?: string | null;
    retryAtMs?: number;
    nowMs: number;
  }): Promise<MinecraftActorControlState> {
    const db = await this.getDb();
    const normalized = {
      resourceId: requireText(input.resourceId, "resourceId", 256),
      wakeId: requireText(input.wakeId, "wakeId", 512),
      decisionId: requireText(input.decisionId, "decisionId", 256),
      status: input.status,
      summary: normalizeOptionalText(input.summary, 4_000),
      error: normalizeOptionalText(input.error, 8_000),
      persistentState: input.persistentState,
      currentGoal: input.currentGoal,
      retryAtMs: input.retryAtMs,
      nowMs: requireTimestamp(input.nowMs, "nowMs")
    };
    const appendedEvents: MinecraftActorJournalEvent[] = [];
    const complete = db.transaction(() => {
      const state = requireControlStateSync(db, normalized.resourceId);
      if (state.activeWakeId !== normalized.wakeId || state.activeDecisionId !== normalized.decisionId) {
        throw new Error(`Minecraft Actor 当前 decision 已变化：${normalized.decisionId}`);
      }
      const wake = requireWakeSync(db, normalized.resourceId, normalized.wakeId);
      const requestId = wake.sourceType === "owner_request" ? wake.sourceId : null;
      const shouldRetry = normalized.status === "failed" && normalized.retryAtMs !== undefined;
      const wakeStatus = shouldRetry ? "pending" : normalized.status;
      db.prepare(`
        UPDATE minecraft_actor_wake_mailbox
        SET status = ?, next_attempt_at_ms = ?, last_error = ?, updated_at_ms = ?, completed_at_ms = ?
        WHERE resource_id = ? AND wake_id = ? AND decision_id = ? AND status = 'running'
      `).run(
        wakeStatus,
        shouldRetry ? normalized.retryAtMs : normalized.nowMs,
        normalized.error,
        normalized.nowMs,
        shouldRetry ? null : normalized.nowMs,
        normalized.resourceId,
        normalized.wakeId,
        normalized.decisionId
      );
      db.prepare(`
        UPDATE minecraft_actor_decisions
        SET status = ?, decision_summary = ?, error = ?, updated_at_ms = ?, completed_at_ms = ?
        WHERE resource_id = ? AND decision_id = ? AND status = 'running'
      `).run(
        shouldRetry ? "queued" : normalized.status,
        normalized.summary,
        normalized.error,
        normalized.nowMs,
        shouldRetry ? null : normalized.nowMs,
        normalized.resourceId,
        normalized.decisionId
      );
      if (requestId) {
        const requestStatus: MinecraftActorRequestStatus = shouldRetry
          ? "queued"
          : normalized.status === "dead_letter" ? "failed" : normalized.status;
        db.prepare(`
          UPDATE minecraft_actor_requests
          SET status = ?, result_summary = ?, error = ?, updated_at_ms = ?, completed_at_ms = ?
          WHERE resource_id = ? AND request_id = ?
        `).run(
          requestStatus,
          normalized.summary,
          normalized.error,
          normalized.nowMs,
          shouldRetry ? null : normalized.nowMs,
          normalized.resourceId,
          requestId
        );
      }
      if (normalized.status === "completed" && normalized.persistentState !== undefined) {
        db.prepare(`
          UPDATE runtime_minecraft_actors
          SET persistent_state = ?, current_goal = ?
          WHERE resource_id = ?
        `).run(normalized.persistentState, normalized.currentGoal ?? null, normalized.resourceId);
        db.prepare(`
          UPDATE runtime_resources SET summary = ?, last_accessed_at_ms = ?
          WHERE resource_id = ? AND status = 'active'
        `).run(normalized.summary ?? "决策完成", normalized.nowMs, normalized.resourceId);
      }
      const pending = db.prepare(`
        SELECT 1 FROM minecraft_actor_wake_mailbox
        WHERE resource_id = ? AND status = 'pending'
        LIMIT 1
      `).get(normalized.resourceId) !== undefined;
      const nextRevision = state.revision + 1;
      updateControlStateSync(db, normalized.resourceId, {
        revision: nextRevision,
        loopPhase: pending ? "queued" : normalized.status === "failed" || normalized.status === "dead_letter" ? "error" : "idle",
        activeWakeId: null,
        activeDecisionId: null,
        lastError: normalized.error,
        updatedAtMs: normalized.nowMs
      });
      appendedEvents.push(appendEventSync(db, {
        resourceId: normalized.resourceId,
        eventType: shouldRetry ? "decision_retry_scheduled" : `decision_${normalized.status}`,
        severity: normalized.status === "completed" ? "info" : normalized.status === "interrupted" ? "warning" : "critical",
        actorRevision: nextRevision,
        requestId,
        decisionId: normalized.decisionId,
        payload: {
          wakeId: normalized.wakeId,
          status: shouldRetry ? "queued" : normalized.status,
          summary: normalized.summary,
          error: normalized.error,
          retryAtMs: normalized.retryAtMs ?? null
        },
        occurredAtMs: normalized.nowMs
      }));
      return requireControlStateSync(db, normalized.resourceId);
    });
    const result = complete();
    this.publish(appendedEvents);
    return result;
  }

  async recoverInterruptedDecisions(nowMs: number): Promise<number> {
    const db = await this.getDb();
    const normalizedNow = requireTimestamp(nowMs, "nowMs");
    const appendedEvents: MinecraftActorJournalEvent[] = [];
    const recover = db.transaction(() => {
      db.prepare(`
        INSERT INTO minecraft_actor_control_state (
          resource_id, owner_principal_id, revision, loop_phase, updated_at_ms
        )
        SELECT resource_id, COALESCE(NULLIF(owner_session_id, ''), 'legacy-owner'), 0, 'idle', ?
        FROM runtime_resources
        WHERE kind = 'minecraft_actor' AND status = 'active'
        ON CONFLICT(resource_id) DO NOTHING
      `).run(normalizedNow);
      const running = db.prepare(`
        SELECT w.resource_id AS resourceId, w.wake_id AS wakeId,
               w.decision_id AS decisionId, d.request_id AS requestId
        FROM minecraft_actor_wake_mailbox w
        JOIN runtime_resources r ON r.resource_id = w.resource_id AND r.status = 'active'
        LEFT JOIN minecraft_actor_decisions d
          ON d.resource_id = w.resource_id AND d.decision_id = w.decision_id
        WHERE w.status = 'running'
      `).all() as Array<{
        resourceId: string;
        wakeId: string;
        decisionId: string;
        requestId: string | null;
      }>;
      for (const item of running) {
        db.prepare(`
          UPDATE minecraft_actor_wake_mailbox
          SET status = 'pending', next_attempt_at_ms = ?, updated_at_ms = ?, last_error = 'parent_restarted'
          WHERE resource_id = ? AND wake_id = ?
        `).run(normalizedNow, normalizedNow, item.resourceId, item.wakeId);
        db.prepare(`
          UPDATE minecraft_actor_decisions
          SET status = 'queued', updated_at_ms = ?, error = 'parent_restarted', completed_at_ms = NULL
          WHERE resource_id = ? AND decision_id = ?
        `).run(normalizedNow, item.resourceId, item.decisionId);
        db.prepare(`
          UPDATE minecraft_actor_requests
          SET status = 'queued', updated_at_ms = ?, error = 'parent_restarted', completed_at_ms = NULL
          WHERE resource_id = ? AND decision_id = ? AND status = 'running'
        `).run(normalizedNow, item.resourceId, item.decisionId);
        const state = requireControlStateSync(db, item.resourceId);
        updateControlStateSync(db, item.resourceId, {
          revision: state.revision + 1,
          loopPhase: "queued",
          activeWakeId: null,
          activeDecisionId: null,
          lastError: "parent_restarted",
          updatedAtMs: normalizedNow
        });
        appendedEvents.push(appendEventSync(db, {
          resourceId: item.resourceId,
          eventType: "decision_recovered",
          severity: "warning",
          actorRevision: state.revision + 1,
          requestId: item.requestId,
          decisionId: item.decisionId,
          payload: { wakeId: item.wakeId, reason: "parent_restarted" },
          occurredAtMs: normalizedNow
        }));
      }
      return running.length;
    });
    const result = recover();
    this.publish(appendedEvents);
    return result;
  }

  async closeActor(resourceId: string, reason: string, nowMs: number): Promise<MinecraftActorControlState> {
    const db = await this.getDb();
    const normalizedResourceId = requireText(resourceId, "resourceId", 256);
    const normalizedReason = requireText(reason, "reason", 1_000);
    const normalizedNow = requireTimestamp(nowMs, "nowMs");
    const appendedEvents: MinecraftActorJournalEvent[] = [];
    const close = db.transaction(() => {
      const state = requireControlStateSync(db, normalizedResourceId);
      if (state.loopPhase === "closed") return state;
      const nextRevision = state.revision + 1;
      db.prepare(`
        UPDATE minecraft_actor_wake_mailbox
        SET status = 'interrupted', last_error = ?, updated_at_ms = ?, completed_at_ms = ?
        WHERE resource_id = ? AND status IN ('pending', 'running')
      `).run(normalizedReason, normalizedNow, normalizedNow, normalizedResourceId);
      db.prepare(`
        UPDATE minecraft_actor_decisions
        SET status = 'interrupted', error = ?, updated_at_ms = ?, completed_at_ms = ?
        WHERE resource_id = ? AND status IN ('queued', 'running')
      `).run(normalizedReason, normalizedNow, normalizedNow, normalizedResourceId);
      db.prepare(`
        UPDATE minecraft_actor_requests
        SET status = 'cancelled', error = ?, updated_at_ms = ?, completed_at_ms = ?
        WHERE resource_id = ? AND status IN ('queued', 'running')
      `).run(normalizedReason, normalizedNow, normalizedNow, normalizedResourceId);
      updateControlStateSync(db, normalizedResourceId, {
        revision: nextRevision,
        loopPhase: "closed",
        activeWakeId: null,
        activeDecisionId: null,
        lastError: normalizedReason,
        updatedAtMs: normalizedNow
      });
      const updated = db.prepare(`
        UPDATE runtime_resources
        SET status = 'closed', last_accessed_at_ms = ?
        WHERE resource_id = ? AND kind = 'minecraft_actor' AND status = 'active'
      `).run(normalizedNow, normalizedResourceId);
      if (updated.changes !== 1) throw new Error(`Minecraft Actor 资源不是 active：${normalizedResourceId}`);
      appendedEvents.push(appendEventSync(db, {
        resourceId: normalizedResourceId,
        eventType: "actor_closed",
        severity: "warning",
        actorRevision: nextRevision,
        requestId: null,
        decisionId: state.activeDecisionId,
        payload: { reason: normalizedReason },
        occurredAtMs: normalizedNow
      }));
      return requireControlStateSync(db, normalizedResourceId);
    });
    const result = close();
    this.publish(appendedEvents);
    return result;
  }

  async listRequests(resourceId: string, limit = 100): Promise<MinecraftActorRequestRecord[]> {
    const db = await this.getDb();
    const rows = db.prepare(`
      SELECT * FROM minecraft_actor_requests
      WHERE resource_id = ?
      ORDER BY created_at_ms DESC, request_id DESC
      LIMIT ?
    `).all(requireText(resourceId, "resourceId", 256), clampLimit(limit, 200)) as RequestRow[];
    return rows.map(mapRequestRow);
  }

  async getRequest(resourceId: string, requestId: string): Promise<MinecraftActorRequestRecord | null> {
    const db = await this.getDb();
    const row = db.prepare(`
      SELECT * FROM minecraft_actor_requests WHERE resource_id = ? AND request_id = ?
    `).get(requireText(resourceId, "resourceId", 256), requireText(requestId, "requestId", 256)) as RequestRow | undefined;
    return row ? mapRequestRow(row) : null;
  }

  async listEvents(resourceId: string, afterEventId = 0, limit = 256): Promise<MinecraftActorJournalEvent[]> {
    const db = await this.getDb();
    const rows = db.prepare(`
      SELECT * FROM minecraft_actor_events
      WHERE resource_id = ? AND event_id > ?
      ORDER BY event_id ASC
      LIMIT ?
    `).all(
      requireText(resourceId, "resourceId", 256),
      requireNonNegativeInteger(afterEventId, "afterEventId"),
      clampLimit(limit, 256)
    ) as EventRow[];
    return rows.map(mapEventRow);
  }

  async getLatestEventId(resourceId: string): Promise<number> {
    const db = await this.getDb();
    const row = db.prepare(`
      SELECT MAX(event_id) AS eventId FROM minecraft_actor_events WHERE resource_id = ?
    `).get(requireText(resourceId, "resourceId", 256)) as { eventId: number | null };
    return row.eventId ?? 0;
  }

  private async getDb(): Promise<SqliteDatabase> {
    await this.stateDatabase.init();
    return this.stateDatabase.getDb();
  }

  private publish(events: MinecraftActorJournalEvent[]): void {
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // The journal commit is authoritative; projections cannot roll it back.
        }
      }
    }
  }
}

interface RequestRow {
  resource_id: string;
  request_id: string;
  idempotency_key: string;
  fingerprint: string;
  owner_principal_id: string;
  owner_session_id: string;
  instruction: string;
  constraints_text: string | null;
  priority: MinecraftActorRequestPriority;
  status: MinecraftActorRequestStatus;
  decision_id: string | null;
  result_summary: string | null;
  error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
}

interface WakeRow {
  resource_id: string;
  wake_id: string;
  source_type: MinecraftActorWakeSource;
  source_id: string;
  fingerprint: string;
  priority: MinecraftActorWakePriority;
  wake_type: string;
  summary: string;
  details_json: string | null;
  status: MinecraftActorWakeStatus;
  decision_id: string;
  attempt_count: number;
  next_attempt_at_ms: number;
  last_error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
}

interface DecisionRow {
  resource_id: string;
  decision_id: string;
  wake_id: string;
  request_id: string | null;
  status: MinecraftActorDecisionStatus;
  attempt_count: number;
  wake_type: string;
  wake_summary: string;
  decision_summary: string | null;
  error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
}

interface EventRow {
  event_id: number;
  resource_id: string;
  event_type: string;
  severity: MinecraftActorJournalEvent["severity"];
  actor_revision: number;
  request_id: string | null;
  decision_id: string | null;
  payload_json: string;
  occurred_at_ms: number;
}

function normalizeRequestInput(input: {
  resourceId: string;
  requestId?: string;
  idempotencyKey: string;
  ownerPrincipalId: string;
  ownerSessionId: string;
  instruction: string;
  constraints?: string | null;
  priority?: MinecraftActorRequestPriority;
  expectedRevision?: number;
  nowMs: number;
}) {
  return {
    resourceId: requireText(input.resourceId, "resourceId", 256),
    requestId: input.requestId === undefined ? undefined : requireText(input.requestId, "requestId", 256),
    idempotencyKey: requireText(input.idempotencyKey, "idempotencyKey", 256),
    ownerPrincipalId: requireText(input.ownerPrincipalId, "ownerPrincipalId", 256),
    ownerSessionId: requireText(input.ownerSessionId, "ownerSessionId", 512),
    instruction: requireText(input.instruction, "instruction", 8_000),
    constraints: normalizeOptionalText(input.constraints, 4_000),
    priority: input.priority ?? "normal",
    expectedRevision: input.expectedRevision === undefined
      ? undefined
      : requireNonNegativeInteger(input.expectedRevision, "expectedRevision"),
    nowMs: requireTimestamp(input.nowMs, "nowMs")
  };
}

function requestFingerprint(input: ReturnType<typeof normalizeRequestInput>): string {
  return createFingerprint({
    ownerPrincipalId: input.ownerPrincipalId,
    ownerSessionId: input.ownerSessionId,
    instruction: input.instruction,
    constraints: input.constraints,
    priority: input.priority
  });
}

function createFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function getControlStateSync(db: SqliteDatabase, resourceId: string): MinecraftActorControlState | null {
  const row = db.prepare(`
    SELECT resource_id AS resourceId, owner_principal_id AS ownerPrincipalId,
           revision, loop_phase AS loopPhase, active_wake_id AS activeWakeId,
           active_decision_id AS activeDecisionId, last_error AS lastError,
           updated_at_ms AS updatedAtMs
    FROM minecraft_actor_control_state WHERE resource_id = ?
  `).get(resourceId) as MinecraftActorControlState | undefined;
  return row ?? null;
}

function requireControlStateSync(db: SqliteDatabase, resourceId: string): MinecraftActorControlState {
  const state = getControlStateSync(db, resourceId);
  if (!state) throw new Error(`Minecraft Actor 控制状态不存在：${resourceId}`);
  return state;
}

function updateControlStateSync(
  db: SqliteDatabase,
  resourceId: string,
  state: Omit<MinecraftActorControlState, "resourceId" | "ownerPrincipalId">
): void {
  const result = db.prepare(`
    UPDATE minecraft_actor_control_state
    SET revision = @revision,
        loop_phase = @loopPhase,
        active_wake_id = @activeWakeId,
        active_decision_id = @activeDecisionId,
        last_error = @lastError,
        updated_at_ms = @updatedAtMs
    WHERE resource_id = @resourceId
  `).run({ resourceId, ...state });
  if (result.changes !== 1) throw new Error(`Minecraft Actor 控制状态不存在：${resourceId}`);
}

function requireRequestSync(db: SqliteDatabase, resourceId: string, requestId: string): MinecraftActorRequestRecord {
  const row = db.prepare(`
    SELECT * FROM minecraft_actor_requests WHERE resource_id = ? AND request_id = ?
  `).get(resourceId, requestId) as RequestRow | undefined;
  if (!row) throw new Error(`Minecraft Actor 请求不存在：${requestId}`);
  return mapRequestRow(row);
}

function requireWakeSync(db: SqliteDatabase, resourceId: string, wakeId: string): MinecraftActorWakeRecord {
  const row = db.prepare(`
    SELECT * FROM minecraft_actor_wake_mailbox WHERE resource_id = ? AND wake_id = ?
  `).get(resourceId, wakeId) as WakeRow | undefined;
  if (!row) throw new Error(`Minecraft Actor 唤醒不存在：${wakeId}`);
  return mapWakeRow(row);
}

function requireDecisionSync(db: SqliteDatabase, resourceId: string, decisionId: string): MinecraftActorDecisionRecord {
  const row = db.prepare(`
    SELECT * FROM minecraft_actor_decisions WHERE resource_id = ? AND decision_id = ?
  `).get(resourceId, decisionId) as DecisionRow | undefined;
  if (!row) throw new Error(`Minecraft Actor 决策不存在：${decisionId}`);
  return mapDecisionRow(row);
}

function appendEventSync(
  db: SqliteDatabase,
  event: Omit<MinecraftActorJournalEvent, "eventId">
): MinecraftActorJournalEvent {
  const result = db.prepare(`
    INSERT INTO minecraft_actor_events (
      resource_id, event_type, severity, actor_revision,
      request_id, decision_id, payload_json, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.resourceId,
    event.eventType,
    event.severity,
    event.actorRevision,
    event.requestId,
    event.decisionId,
    JSON.stringify(event.payload),
    event.occurredAtMs
  );
  return { ...event, eventId: Number(result.lastInsertRowid) };
}

function mapRequestRow(row: RequestRow): MinecraftActorRequestRecord {
  return {
    resourceId: row.resource_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    ownerPrincipalId: row.owner_principal_id,
    ownerSessionId: row.owner_session_id,
    instruction: row.instruction,
    constraints: row.constraints_text,
    priority: row.priority,
    status: row.status,
    decisionId: row.decision_id,
    resultSummary: row.result_summary,
    error: row.error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    startedAtMs: row.started_at_ms,
    completedAtMs: row.completed_at_ms
  };
}

function mapWakeRow(row: WakeRow): MinecraftActorWakeRecord {
  return {
    resourceId: row.resource_id,
    wakeId: row.wake_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    priority: row.priority,
    wakeType: row.wake_type,
    summary: row.summary,
    details: row.details_json === null ? null : parseJsonValue(row.details_json, "wake.details"),
    status: row.status,
    decisionId: row.decision_id,
    attemptCount: row.attempt_count,
    nextAttemptAtMs: row.next_attempt_at_ms,
    lastError: row.last_error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    completedAtMs: row.completed_at_ms
  };
}

function mapDecisionRow(row: DecisionRow): MinecraftActorDecisionRecord {
  return {
    resourceId: row.resource_id,
    decisionId: row.decision_id,
    wakeId: row.wake_id,
    requestId: row.request_id,
    status: row.status,
    attemptCount: row.attempt_count,
    wakeType: row.wake_type,
    wakeSummary: row.wake_summary,
    decisionSummary: row.decision_summary,
    error: row.error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    startedAtMs: row.started_at_ms,
    completedAtMs: row.completed_at_ms
  };
}

function mapEventRow(row: EventRow): MinecraftActorJournalEvent {
  return {
    eventId: row.event_id,
    resourceId: row.resource_id,
    eventType: row.event_type,
    severity: row.severity,
    actorRevision: row.actor_revision,
    requestId: row.request_id,
    decisionId: row.decision_id,
    payload: parseJsonValue(row.payload_json, "event.payload"),
    occurredAtMs: row.occurred_at_ms
  };
}

function parseJsonValue(raw: string, label: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON`, { cause: error });
  }
}

function requireOwner(state: MinecraftActorControlState, ownerPrincipalId: string): void {
  if (state.ownerPrincipalId !== ownerPrincipalId) {
    throw new Error(`Minecraft Actor 不属于当前主体：${state.resourceId}`);
  }
}

function requireExpectedRevision(state: MinecraftActorControlState, expectedRevision: number | undefined): void {
  if (expectedRevision !== undefined && state.revision !== expectedRevision) {
    throw new MinecraftActorRevisionConflictError(expectedRevision, state.revision);
  }
}

function requireText(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} 不能为空`);
  if (normalized.length > maxLength) throw new Error(`${label} 超过长度限制 ${maxLength}`);
  return normalized;
}

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new Error(`文本超过长度限制 ${maxLength}`);
  return normalized;
}

function requireTimestamp(value: unknown, label: string): number {
  return requireNonNegativeInteger(value, label);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负安全整数`);
  }
  return value;
}

function clampLimit(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("limit 必须是正整数");
  return Math.min(value, max);
}
