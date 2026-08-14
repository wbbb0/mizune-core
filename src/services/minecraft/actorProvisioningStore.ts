import { createHash } from "node:crypto";
import type { StateDatabase } from "#data/state/stateDatabase.ts";
import type { SqliteDatabase } from "#data/sqlite/sqliteService.ts";
import type {
  MinecraftActorRecoveryState,
  MinecraftRuntimeIncarnationRecord
} from "#runtime/resources/resourceTypes.ts";
import {
  MinecraftActorIdempotencyConflictError,
  type MinecraftActorJournalEvent,
  type MinecraftActorRequestPriority
} from "./actorControlStore.ts";
import { MinecraftActorJournal } from "./actorJournal.ts";

export interface MinecraftActorDelegationReceipt {
  resourceId: string;
  requestId: string;
  revision: number;
  created: boolean;
  replayed: boolean;
}

interface IncarnationRow {
  runtime_instance_id: string;
  resource_id: string;
  attempt_id: string;
  status: MinecraftRuntimeIncarnationRecord["status"];
  daemon_pid: number | null;
  daemon_start_ticks: string | null;
  client_pid: number | null;
  client_start_ticks: string | null;
  process_group_id: number | null;
  boot_id: string;
  socket_path: string;
  game_directory: string;
  token_file: string;
  bridge_port: number | null;
  started_at_ms: number;
  stopped_at_ms: number | null;
  exit_reason: string | null;
}

export class MinecraftActorProvisioningStore {
  constructor(
    private readonly stateDatabase: StateDatabase,
    private readonly journal = new MinecraftActorJournal()
  ) {}

  async delegate(input: {
    resourceId: string;
    ownerPrincipalId: string;
    ownerSessionId: string;
    idempotencyKey: string;
    title: string;
    summary: string;
    actor: MinecraftActorRecoveryState;
    instruction: string;
    constraints?: string | null;
    priority?: MinecraftActorRequestPriority;
    nowMs: number;
  }): Promise<MinecraftActorDelegationReceipt> {
    const normalized = normalize(input);
    await this.stateDatabase.init();
    const db = this.stateDatabase.getDb();
    const appendedEvents: MinecraftActorJournalEvent[] = [];
    const delegate = db.transaction(() => delegateSync(db, normalized, appendedEvents));
    const receipt = delegate.immediate();
    this.journal.publish(appendedEvents);
    return receipt;
  }

  async beginAttempt(input: {
    resourceId: string;
    attemptId: string;
    runtimeInstanceId: string;
    socketPath: string;
    gameDirectory: string;
    tokenFile: string;
    bootId: string;
    nowMs: number;
  }): Promise<void> {
    await this.stateDatabase.init();
    const db = this.stateDatabase.getDb();
    const appendedEvents: MinecraftActorJournalEvent[] = [];
    const begin = db.transaction(() => {
      const resourceId = text(input.resourceId, "resourceId", 256);
      const attemptId = text(input.attemptId, "attemptId", 256);
      const runtimeInstanceId = text(input.runtimeInstanceId, "runtimeInstanceId", 256);
      const activeIncarnation = db.prepare(`
        SELECT runtime_instance_id AS runtimeInstanceId, status
        FROM minecraft_runtime_incarnations
        WHERE resource_id = ? AND status IN ('starting', 'running', 'stopping')
        LIMIT 1
      `).get(resourceId) as { runtimeInstanceId: string; status: string } | undefined;
      if (activeIncarnation) {
        throw new Error(
          `Minecraft Runtime 旧实例尚未确认退出：${activeIncarnation.runtimeInstanceId} (${activeIncarnation.status})`
        );
      }
      const control = db.prepare(`
        SELECT loop_phase AS loopPhase, active_wake_id AS activeWakeId,
               active_decision_id AS activeDecisionId
        FROM minecraft_actor_control_state WHERE resource_id = ?
      `).get(resourceId) as {
        loopPhase: string;
        activeWakeId: string | null;
        activeDecisionId: string | null;
      } | undefined;
      if (!control) throw new Error(`Minecraft Actor 控制状态不存在：${resourceId}`);
      if (control.loopPhase === "deciding" || control.activeWakeId || control.activeDecisionId) {
        throw new Error(`Minecraft Actor 当前决策尚未收敛，不能启动新 Runtime：${resourceId}`);
      }
      const updated = db.prepare(`
        UPDATE minecraft_actor_bindings
        SET provision_status = 'running', provision_phase = 'allocating',
            failure_code = NULL, failure_message = NULL, retry_at_ms = NULL,
            attempt_id = ?
        WHERE resource_id = ? AND desired_state = 'open'
          AND provision_status IN ('pending', 'retry_wait', 'failed', 'stopped')
          AND (provision_status <> 'retry_wait' OR retry_at_ms IS NULL OR retry_at_ms <= ?)
      `).run(attemptId, resourceId, integer(input.nowMs, "nowMs"));
      if (updated.changes !== 1) throw new Error(`Minecraft Actor 不能开始新的 provision attempt：${input.resourceId}`);
      db.prepare(`
        INSERT INTO minecraft_runtime_incarnations (
          runtime_instance_id, resource_id, attempt_id, status,
          boot_id, socket_path, game_directory, token_file, started_at_ms
        ) VALUES (?, ?, ?, 'starting', ?, ?, ?, ?, ?)
      `).run(
        runtimeInstanceId,
        resourceId,
        attemptId,
        text(input.bootId, "bootId", 256),
        text(input.socketPath, "socketPath", 4_096),
        text(input.gameDirectory, "gameDirectory", 4_096),
        text(input.tokenFile, "tokenFile", 4_096),
        input.nowMs
      );
      db.prepare(`
        UPDATE minecraft_actor_control_state
        SET revision = revision + 1, loop_phase = 'paused',
            last_error = NULL, updated_at_ms = ?
        WHERE resource_id = ? AND loop_phase NOT IN ('paused', 'closed')
      `).run(input.nowMs, resourceId);
      appendedEvents.push(appendProvisionEvent(
        db, input.resourceId, "actor_provisioning_started", "allocating", input.nowMs
      ));
    });
    begin.immediate();
    this.journal.publish(appendedEvents);
  }

  async markIncarnationStopping(input: {
    resourceId: string;
    attemptId: string;
    runtimeInstanceId: string;
    reason: string;
    nowMs: number;
  }): Promise<MinecraftRuntimeIncarnationRecord> {
    await this.stateDatabase.init();
    const db = this.stateDatabase.getDb();
    const update = db.transaction(() => {
      integer(input.nowMs, "nowMs");
      const updated = db.prepare(`
        UPDATE minecraft_runtime_incarnations
        SET status = 'stopping', exit_reason = ?
        WHERE runtime_instance_id = ? AND resource_id = ? AND attempt_id = ?
          AND status IN ('starting', 'running')
      `).run(
        text(input.reason, "reason", 2_000),
        text(input.runtimeInstanceId, "runtimeInstanceId", 256),
        text(input.resourceId, "resourceId", 256),
        text(input.attemptId, "attemptId", 256)
      );
      if (updated.changes !== 1) throw new Error(`Minecraft Runtime incarnation 不能进入停止态：${input.runtimeInstanceId}`);
      return requireIncarnation(db, input.runtimeInstanceId);
    });
    return update.immediate();
  }

  async markIncarnationTerminated(input: {
    resourceId: string;
    attemptId: string;
    runtimeInstanceId: string;
    outcome: "stopped" | "failed";
    exitReason: string;
    expectedDaemonPid?: number | null;
    expectedDaemonStartTicks?: string | null;
    expectedClientPid?: number | null;
    expectedClientStartTicks?: string | null;
    failureCode?: string | null;
    retryAtMs?: number | null;
    nowMs: number;
  }): Promise<MinecraftRuntimeIncarnationRecord> {
    await this.stateDatabase.init();
    const db = this.stateDatabase.getDb();
    const appendedEvents: MinecraftActorJournalEvent[] = [];
    const terminate = db.transaction(() => {
      const resourceId = text(input.resourceId, "resourceId", 256);
      const attemptId = text(input.attemptId, "attemptId", 256);
      const runtimeInstanceId = text(input.runtimeInstanceId, "runtimeInstanceId", 256);
      const incarnation = requireIncarnation(db, runtimeInstanceId);
      if (incarnation.resourceId !== resourceId || incarnation.attemptId !== attemptId) {
        throw new Error(`Minecraft Runtime incarnation 不属于当前 attempt：${runtimeInstanceId}`);
      }
      requireProcessFingerprint({
        runtimeInstanceId,
        processName: "daemon",
        recordedPid: incarnation.daemonPid,
        recordedStartTicks: incarnation.daemonStartTicks,
        expectedPid: input.expectedDaemonPid,
        expectedStartTicks: input.expectedDaemonStartTicks
      });
      requireProcessFingerprint({
        runtimeInstanceId,
        processName: "client",
        recordedPid: incarnation.clientPid,
        recordedStartTicks: incarnation.clientStartTicks,
        expectedPid: input.expectedClientPid,
        expectedStartTicks: input.expectedClientStartTicks
      });
      if (
        incarnation.status !== "starting"
        && incarnation.status !== "running"
        && incarnation.status !== "stopping"
      ) {
        throw new Error(`Minecraft Runtime incarnation 已经终止：${runtimeInstanceId}`);
      }
      const exitReason = text(input.exitReason, "exitReason", 2_000);
      db.prepare(`
        UPDATE minecraft_runtime_incarnations
        SET status = ?, stopped_at_ms = ?, exit_reason = ?
        WHERE runtime_instance_id = ?
      `).run(input.outcome, integer(input.nowMs, "nowMs"), exitReason, runtimeInstanceId);
      const failureCode = input.outcome === "failed"
        ? (input.failureCode == null
            ? "runtime_process_failed"
            : text(input.failureCode, "failureCode", 256))
        : null;
      const retryAtMs = input.outcome === "failed" && input.retryAtMs != null
        ? integer(input.retryAtMs, "retryAtMs")
        : null;
      const nextProvisionStatus = input.outcome === "failed" && retryAtMs !== null
        ? "retry_wait"
        : input.outcome;
      const binding = db.prepare(`
        UPDATE minecraft_actor_bindings
        SET provision_status = ?,
            failure_code = ?, failure_message = ?, retry_at_ms = ?,
            attempt_id = NULL
        WHERE resource_id = ? AND desired_state = 'open' AND attempt_id = ?
      `).run(
        nextProvisionStatus,
        failureCode,
        input.outcome === "failed" ? exitReason : null,
        retryAtMs,
        resourceId,
        attemptId
      );
      if (binding.changes === 1) {
        db.prepare(`
          UPDATE minecraft_actor_control_state
          SET revision = revision + 1, loop_phase = 'paused',
              last_error = ?, updated_at_ms = ?
          WHERE resource_id = ? AND active_wake_id IS NULL
            AND loop_phase NOT IN ('paused', 'closed')
        `).run(input.outcome === "failed" ? exitReason : null, input.nowMs, resourceId);
        appendedEvents.push(appendProvisionEvent(
          db,
          resourceId,
          input.outcome === "failed" ? "actor_provisioning_failed" : "actor_provisioning_stopped",
          "waiting_daemon",
          input.nowMs,
          requireRevision(db, resourceId),
          failureCode ? { failureCode } : {}
        ));
      }
      return requireIncarnation(db, runtimeInstanceId);
    });
    const result = terminate.immediate();
    this.journal.publish(appendedEvents);
    return result;
  }

  async markIncarnationRunning(input: {
    resourceId: string;
    attemptId: string;
    runtimeInstanceId: string;
    daemonPid: number;
    daemonStartTicks: string;
    processGroupId: number;
    clientPid?: number | null;
    clientStartTicks?: string | null;
    bridgePort?: number | null;
    nowMs: number;
  }): Promise<MinecraftRuntimeIncarnationRecord> {
    await this.stateDatabase.init();
    const db = this.stateDatabase.getDb();
    const update = db.transaction(() => {
      integer(input.nowMs, "nowMs");
      const resourceId = text(input.resourceId, "resourceId", 256);
      const attemptId = text(input.attemptId, "attemptId", 256);
      const runtimeInstanceId = text(input.runtimeInstanceId, "runtimeInstanceId", 256);
      const binding = db.prepare(`
        SELECT 1 FROM minecraft_actor_bindings
        WHERE resource_id = ? AND desired_state = 'open'
          AND provision_status = 'running' AND attempt_id = ?
      `).get(resourceId, attemptId);
      if (!binding) throw new Error(`Minecraft Actor provision attempt 已失效：${resourceId}`);
      const hasClientPid = input.clientPid != null;
      const hasClientStartTicks = input.clientStartTicks != null;
      if (hasClientPid !== hasClientStartTicks) {
        throw new Error("clientPid 与 clientStartTicks 必须同时提供");
      }
      const updated = db.prepare(`
        UPDATE minecraft_runtime_incarnations
        SET status = 'running', daemon_pid = ?, daemon_start_ticks = ?,
            client_pid = ?, client_start_ticks = ?, process_group_id = ?, bridge_port = ?
        WHERE runtime_instance_id = ? AND resource_id = ? AND attempt_id = ?
          AND status = 'starting'
      `).run(
        positiveInteger(input.daemonPid, "daemonPid"),
        text(input.daemonStartTicks, "daemonStartTicks", 256),
        input.clientPid == null ? null : positiveInteger(input.clientPid, "clientPid"),
        input.clientStartTicks == null ? null : text(input.clientStartTicks, "clientStartTicks", 256),
        positiveInteger(input.processGroupId, "processGroupId"),
        input.bridgePort == null ? null : port(input.bridgePort, "bridgePort"),
        runtimeInstanceId,
        resourceId,
        attemptId
      );
      if (updated.changes !== 1) throw new Error(`Minecraft Runtime incarnation 已失效：${runtimeInstanceId}`);
      return requireIncarnation(db, runtimeInstanceId);
    });
    return update.immediate();
  }

  async recordRecoveredProcessIdentity(input: {
    resourceId: string;
    attemptId: string;
    runtimeInstanceId: string;
    daemonPid: number;
    daemonStartTicks: string;
    processGroupId: number;
    targetStatus: "running" | "stopping";
    nowMs: number;
  }): Promise<MinecraftRuntimeIncarnationRecord> {
    await this.stateDatabase.init();
    const db = this.stateDatabase.getDb();
    const recover = db.transaction(() => {
      const resourceId = text(input.resourceId, "resourceId", 256);
      const attemptId = text(input.attemptId, "attemptId", 256);
      const runtimeInstanceId = text(input.runtimeInstanceId, "runtimeInstanceId", 256);
      integer(input.nowMs, "nowMs");
      const binding = db.prepare(`
        SELECT desired_state AS desiredState, provision_status AS provisionStatus,
               attempt_id AS attemptId
        FROM minecraft_actor_bindings WHERE resource_id = ?
      `).get(resourceId) as {
        desiredState: string;
        provisionStatus: string;
        attemptId: string | null;
      } | undefined;
      if (!binding) throw new Error(`Minecraft Actor binding 不存在：${resourceId}`);
      if (input.targetStatus === "running" && (
        binding.desiredState !== "open"
        || binding.provisionStatus !== "running"
        || binding.attemptId !== attemptId
      )) {
        throw new Error(`Minecraft Actor provision attempt 已失效：${resourceId}`);
      }
      if (input.targetStatus === "stopping") {
        const control = db.prepare(`
          SELECT loop_phase AS loopPhase, active_wake_id AS activeWakeId,
                 active_decision_id AS activeDecisionId
          FROM minecraft_actor_control_state WHERE resource_id = ?
        `).get(resourceId) as {
          loopPhase: string;
          activeWakeId: string | null;
          activeDecisionId: string | null;
        } | undefined;
        if (
          !control
          || control.loopPhase === "deciding"
          || control.activeWakeId !== null
          || control.activeDecisionId !== null
        ) {
          throw new Error(`Minecraft Actor 当前决策尚未收敛，不能回收 Runtime：${resourceId}`);
        }
      }
      const daemonPid = positiveInteger(input.daemonPid, "daemonPid");
      const processGroupId = positiveInteger(input.processGroupId, "processGroupId");
      if (daemonPid !== processGroupId) throw new Error("受管 Runtime 必须以 daemon PID 作为独立进程组 ID");
      const updated = db.prepare(`
        UPDATE minecraft_runtime_incarnations
        SET status = ?, daemon_pid = ?, daemon_start_ticks = ?, process_group_id = ?
        WHERE runtime_instance_id = ? AND resource_id = ? AND attempt_id = ?
          AND daemon_pid IS NULL AND daemon_start_ticks IS NULL AND process_group_id IS NULL
          AND status IN ('starting', 'stopping')
      `).run(
        input.targetStatus,
        daemonPid,
        text(input.daemonStartTicks, "daemonStartTicks", 256),
        processGroupId,
        runtimeInstanceId,
        resourceId,
        attemptId
      );
      if (updated.changes !== 1) throw new Error(`Minecraft Runtime 自登记身份不能恢复：${runtimeInstanceId}`);
      return requireIncarnation(db, runtimeInstanceId);
    });
    return recover.immediate();
  }

  async getActiveIncarnation(resourceId: string): Promise<MinecraftRuntimeIncarnationRecord | null> {
    await this.stateDatabase.init();
    const db = this.stateDatabase.getDb();
    const row = db.prepare(`
      SELECT * FROM minecraft_runtime_incarnations
      WHERE resource_id = ? AND status IN ('starting', 'running', 'stopping')
      ORDER BY started_at_ms DESC, runtime_instance_id DESC LIMIT 1
    `).get(text(resourceId, "resourceId", 256)) as IncarnationRow | undefined;
    return row ? mapIncarnation(row) : null;
  }

  async countFailedIncarnationsSince(resourceId: string, sinceMs: number): Promise<number> {
    await this.stateDatabase.init();
    const db = this.stateDatabase.getDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS count FROM minecraft_runtime_incarnations
      WHERE resource_id = ? AND status = 'failed' AND started_at_ms >= ?
    `).get(
      text(resourceId, "resourceId", 256),
      integer(sinceMs, "sinceMs")
    ) as { count: number };
    return row.count;
  }

  async hasActiveDecision(resourceId: string): Promise<boolean> {
    await this.stateDatabase.init();
    const db = this.stateDatabase.getDb();
    const state = db.prepare(`
      SELECT loop_phase AS loopPhase, active_wake_id AS activeWakeId,
             active_decision_id AS activeDecisionId
      FROM minecraft_actor_control_state WHERE resource_id = ?
    `).get(text(resourceId, "resourceId", 256)) as {
      loopPhase: string;
      activeWakeId: string | null;
      activeDecisionId: string | null;
    } | undefined;
    if (!state) throw new Error(`Minecraft Actor 控制状态不存在：${resourceId}`);
    return state.loopPhase === "deciding" || state.activeWakeId !== null || state.activeDecisionId !== null;
  }

  async markNeedsAttention(input: {
    resourceId: string;
    failureCode: string;
    failureMessage: string;
    phase: MinecraftActorRecoveryState["binding"]["provisionPhase"];
    nowMs: number;
  }): Promise<void> {
    await this.stateDatabase.init();
    const db = this.stateDatabase.getDb();
    const appendedEvents: MinecraftActorJournalEvent[] = [];
    const update = db.transaction(() => {
      const resourceId = text(input.resourceId, "resourceId", 256);
      const updated = db.prepare(`
        UPDATE minecraft_actor_bindings
        SET provision_status = 'needs_attention', provision_phase = ?,
            failure_code = ?, failure_message = ?, retry_at_ms = NULL, attempt_id = NULL
        WHERE resource_id = ? AND desired_state = 'open'
          AND provision_status <> 'needs_attention'
      `).run(
        input.phase,
        text(input.failureCode, "failureCode", 256),
        text(input.failureMessage, "failureMessage", 2_000),
        resourceId
      );
      if (updated.changes !== 1) return;
      db.prepare(`
        UPDATE minecraft_actor_control_state
        SET revision = revision + 1, loop_phase = 'paused', last_error = ?, updated_at_ms = ?
        WHERE resource_id = ? AND active_wake_id IS NULL
          AND loop_phase NOT IN ('paused', 'closed')
      `).run(input.failureMessage, integer(input.nowMs, "nowMs"), resourceId);
      appendedEvents.push(appendProvisionEvent(
        db,
        resourceId,
        "actor_provisioning_needs_attention",
        input.phase,
        input.nowMs,
        requireRevision(db, resourceId),
        { failureCode: input.failureCode }
      ));
    });
    update.immediate();
    this.journal.publish(appendedEvents);
  }

  async advanceAttempt(input: {
    resourceId: string;
    attemptId: string;
    phase: MinecraftActorRecoveryState["binding"]["provisionPhase"];
    nowMs: number;
  }): Promise<void> {
    await this.stateDatabase.init();
    const db = this.stateDatabase.getDb();
    const appendedEvents: MinecraftActorJournalEvent[] = [];
    const advance = db.transaction(() => {
      const updated = db.prepare(`
        UPDATE minecraft_actor_bindings
        SET provision_phase = ?
        WHERE resource_id = ? AND desired_state = 'open'
          AND provision_status = 'running' AND attempt_id = ?
      `).run(input.phase, input.resourceId, input.attemptId);
      if (updated.changes !== 1) throw new Error(`Minecraft Actor provision attempt 已失效：${input.resourceId}`);
      appendedEvents.push(appendProvisionEvent(
        db, input.resourceId, "actor_provisioning_progress", input.phase, input.nowMs
      ));
    });
    advance.immediate();
    this.journal.publish(appendedEvents);
  }

  async markReady(input: {
    resourceId: string;
    attemptId: string;
    nowMs: number;
  }): Promise<void> {
    await this.stateDatabase.init();
    const db = this.stateDatabase.getDb();
    const appendedEvents: MinecraftActorJournalEvent[] = [];
    const ready = db.transaction(() => {
      const incarnation = db.prepare(`
        SELECT 1 FROM minecraft_runtime_incarnations
        WHERE resource_id = ? AND attempt_id = ? AND status = 'running'
      `).get(input.resourceId, input.attemptId);
      if (!incarnation) {
        throw new Error(`Minecraft Runtime 尚无可用的运行实例：${input.resourceId}`);
      }
      const updated = db.prepare(`
        UPDATE minecraft_actor_bindings
        SET provision_status = 'ready', provision_phase = 'ready',
            failure_code = NULL, failure_message = NULL, retry_at_ms = NULL
        WHERE resource_id = ? AND desired_state = 'open'
          AND provision_status = 'running' AND attempt_id = ?
      `).run(input.resourceId, input.attemptId);
      if (updated.changes !== 1) throw new Error(`Minecraft Actor provision attempt 已失效：${input.resourceId}`);
      const state = db.prepare(`
        SELECT revision FROM minecraft_actor_control_state WHERE resource_id = ?
      `).get(input.resourceId) as { revision: number } | undefined;
      if (!state) throw new Error(`Minecraft Actor 控制状态不存在：${input.resourceId}`);
      const hasPending = db.prepare(`
        SELECT 1 FROM minecraft_actor_wake_mailbox
        WHERE resource_id = ? AND status = 'pending' LIMIT 1
      `).get(input.resourceId) !== undefined;
      db.prepare(`
        UPDATE minecraft_actor_control_state
        SET revision = ?, loop_phase = ?, last_error = NULL, updated_at_ms = ?
        WHERE resource_id = ?
      `).run(state.revision + 1, hasPending ? "queued" : "idle", input.nowMs, input.resourceId);
      db.prepare(`
        UPDATE runtime_resources
        SET summary = 'Minecraft Runtime 已就绪', last_accessed_at_ms = ?
        WHERE resource_id = ? AND status = 'active'
      `).run(input.nowMs, input.resourceId);
      const loopPhase = hasPending ? "queued" : "idle";
      appendedEvents.push(appendProvisionEvent(
        db,
        input.resourceId,
        "actor_ready",
        "ready",
        input.nowMs,
        state.revision + 1,
        { loopPhase }
      ));
    });
    ready.immediate();
    this.journal.publish(appendedEvents);
  }
}

function delegateSync(
  db: SqliteDatabase,
  input: ReturnType<typeof normalize>,
  appendedEvents: MinecraftActorJournalEvent[]
): MinecraftActorDelegationReceipt {
  const replay = db.prepare(`
    SELECT fingerprint, resource_id AS resourceId, request_id AS requestId
    FROM minecraft_actor_delegations
    WHERE owner_principal_id = ? AND idempotency_key = ?
  `).get(input.ownerPrincipalId, input.idempotencyKey) as {
    fingerprint: string;
    resourceId: string;
    requestId: string;
  } | undefined;
  if (replay) {
    if (replay.fingerprint !== input.delegateFingerprint) {
      throw new MinecraftActorIdempotencyConflictError(input.idempotencyKey);
    }
    return {
      resourceId: replay.resourceId,
      requestId: replay.requestId,
      revision: requireRevision(db, replay.resourceId),
      created: false,
      replayed: true
    };
  }

  const binding = db.prepare(`
    SELECT b.resource_id AS resourceId, b.provision_status AS provisionStatus,
           c.owner_principal_id AS ownerPrincipalId
    FROM minecraft_actor_bindings b
    JOIN minecraft_actor_control_state c ON c.resource_id = b.resource_id
    JOIN runtime_resources r ON r.resource_id = b.resource_id
    WHERE b.server_key = ? AND b.identity_ref = ?
      AND b.desired_state = 'open' AND r.status = 'active'
  `).get(input.actor.binding.serverKey, input.actor.binding.identityRef) as {
    resourceId: string;
    provisionStatus: string;
    ownerPrincipalId: string;
  } | undefined;

  const created = binding === undefined;
  const resourceId = binding?.resourceId ?? input.resourceId;
  if (binding && binding.ownerPrincipalId !== input.ownerPrincipalId) {
    throw new Error("该账号已在目标 Minecraft 服务器中由另一个主体持有");
  }
  if (!binding) insertActor(db, input);

  const requestId = `mc_req_${cryptoId()}`;
  const wakeId = `request:${requestId}`;
  const decisionId = `mc_dec_${cryptoId()}`;
  const wakeDetails = {
    requestId,
    instruction: input.instruction,
    constraints: input.constraints,
    ownerPrincipalId: input.ownerPrincipalId
  };
  const requestFingerprint = hash({
    ownerPrincipalId: input.ownerPrincipalId,
    ownerSessionId: input.ownerSessionId,
    instruction: input.instruction,
    constraints: input.constraints,
    priority: input.priority
  });
  const wakeFingerprint = hash({
    wakeId,
    sourceType: "owner_request",
    sourceId: requestId,
    priority: input.priority,
    wakeType: "owner_request",
    summary: input.instruction,
    details: wakeDetails
  });
  const revision = requireRevision(db, resourceId) + 1;

  db.prepare(`
    INSERT INTO minecraft_actor_requests (
      resource_id, request_id, idempotency_key, fingerprint,
      owner_principal_id, owner_session_id, instruction, constraints_text,
      priority, status, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `).run(
    resourceId, requestId, input.idempotencyKey, requestFingerprint,
    input.ownerPrincipalId, input.ownerSessionId, input.instruction,
    input.constraints, input.priority, input.nowMs, input.nowMs
  );
  db.prepare(`
    INSERT INTO minecraft_actor_wake_mailbox (
      resource_id, wake_id, source_type, source_id, fingerprint, priority, wake_type,
      summary, details_json, status, decision_id, next_attempt_at_ms,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'owner_request', ?, ?, ?, 'owner_request', ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    resourceId, wakeId, requestId, wakeFingerprint, input.priority,
    input.instruction, JSON.stringify(wakeDetails), decisionId,
    input.nowMs, input.nowMs, input.nowMs
  );
  db.prepare(`
    UPDATE minecraft_actor_control_state
    SET revision = ?, loop_phase = ?, active_wake_id = NULL,
        active_decision_id = NULL, last_error = NULL, updated_at_ms = ?
    WHERE resource_id = ?
  `).run(
    revision,
    (binding?.provisionStatus ?? input.actor.binding.provisionStatus) === "ready" ? "queued" : "paused",
    input.nowMs,
    resourceId
  );
  db.prepare(`
    INSERT INTO minecraft_actor_delegations (
      owner_principal_id, idempotency_key, fingerprint,
      resource_id, request_id, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.ownerPrincipalId, input.idempotencyKey, input.delegateFingerprint,
    resourceId, requestId, input.nowMs
  );
  const eventResult = db.prepare(`
    INSERT INTO minecraft_actor_events (
      resource_id, event_type, severity, actor_revision,
      request_id, decision_id, payload_json, occurred_at_ms
    ) VALUES (?, ?, 'info', ?, ?, ?, ?, ?)
  `).run(
    resourceId,
    created ? "actor_provisioning_requested" : "owner_request_queued",
    revision,
    requestId,
    decisionId,
    JSON.stringify({
      requestId,
      serverAddress: input.actor.binding.serverAddress,
      instruction: input.instruction,
      priority: input.priority,
      created
    }),
    input.nowMs
  );
  appendedEvents.push({
    eventId: Number(eventResult.lastInsertRowid),
    resourceId,
    eventType: created ? "actor_provisioning_requested" : "owner_request_queued",
    severity: "info",
    actorRevision: revision,
    requestId,
    decisionId,
    payload: {
      requestId,
      serverAddress: input.actor.binding.serverAddress,
      instruction: input.instruction,
      priority: input.priority,
      created
    },
    occurredAtMs: input.nowMs
  });
  return { resourceId, requestId, revision, created, replayed: false };
}

function insertActor(db: SqliteDatabase, input: ReturnType<typeof normalize>): void {
  db.prepare(`
    INSERT INTO runtime_resources (
      resource_id, kind, status, owner_session_id, title, description,
      summary, created_at_ms, last_accessed_at_ms, expires_at_ms
    ) VALUES (?, 'minecraft_actor', 'active', ?, ?, NULL, ?, ?, ?, NULL)
  `).run(input.resourceId, input.ownerSessionId, input.title, input.summary, input.nowMs, input.nowMs);
  db.prepare(`
    INSERT INTO runtime_minecraft_actors (
      resource_id, actor_id, transport_kind, endpoint, protocol_version,
      persistent_state, current_goal, model_refs_json,
      allow_autonomy_policy_change, allow_program_deployment, last_event_sequence
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    input.resourceId, input.actor.actorId, input.actor.transportKind, input.actor.endpoint,
    input.actor.persistentState, input.actor.currentGoal, JSON.stringify(input.actor.modelRefs),
    input.actor.allowAutonomyPolicyChange ? 1 : 0,
    input.actor.allowProgramDeployment ? 1 : 0,
    input.actor.lastEventSequence
  );
  const binding = input.actor.binding;
  db.prepare(`
    INSERT INTO minecraft_actor_bindings (
      resource_id, server_address, server_host, server_port, server_key,
      template_id, template_fingerprint, identity_ref, backend,
      desired_state, provision_status, provision_phase,
      failure_code, failure_message, retry_at_ms, attempt_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.resourceId, binding.serverAddress, binding.serverHost, binding.serverPort,
    binding.serverKey, binding.templateId, binding.templateFingerprint, binding.identityRef,
    binding.backend, binding.desiredState, binding.provisionStatus, binding.provisionPhase,
    binding.failureCode, binding.failureMessage, binding.retryAtMs, binding.attemptId
  );
  db.prepare(`
    INSERT INTO minecraft_actor_control_state (
      resource_id, owner_principal_id, revision, loop_phase, updated_at_ms
    ) VALUES (?, ?, 0, 'paused', ?)
  `).run(input.resourceId, input.ownerPrincipalId, input.nowMs);
}

function normalize(input: {
  resourceId: string;
  ownerPrincipalId: string;
  ownerSessionId: string;
  idempotencyKey: string;
  title: string;
  summary: string;
  actor: MinecraftActorRecoveryState;
  instruction: string;
  constraints?: string | null;
  priority?: MinecraftActorRequestPriority;
  nowMs: number;
}) {
  const normalized = {
    ...input,
    resourceId: text(input.resourceId, "resourceId", 256),
    ownerPrincipalId: text(input.ownerPrincipalId, "ownerPrincipalId", 256),
    ownerSessionId: text(input.ownerSessionId, "ownerSessionId", 512),
    idempotencyKey: text(input.idempotencyKey, "idempotencyKey", 256),
    title: text(input.title, "title", 200),
    summary: text(input.summary, "summary", 4_000),
    instruction: text(input.instruction, "instruction", 8_000),
    constraints: input.constraints == null ? null : text(input.constraints, "constraints", 4_000),
    priority: input.priority ?? "normal",
    nowMs: integer(input.nowMs, "nowMs")
  };
  return {
    ...normalized,
    delegateFingerprint: hash({
      serverKey: input.actor.binding.serverKey,
      identityRef: input.actor.binding.identityRef,
      instruction: normalized.instruction,
      constraints: normalized.constraints,
      priority: normalized.priority
    })
  };
}

function requireRevision(db: SqliteDatabase, resourceId: string): number {
  const row = db.prepare(`
    SELECT revision FROM minecraft_actor_control_state WHERE resource_id = ?
  `).get(resourceId) as { revision: number } | undefined;
  if (!row) throw new Error(`Minecraft Actor 控制状态不存在：${resourceId}`);
  return row.revision;
}

function appendProvisionEvent(
  db: SqliteDatabase,
  resourceId: string,
  eventType: string,
  phase: string,
  nowMs: number,
  revision = requireRevision(db, resourceId),
  extraPayload: Record<string, string> = {}
): MinecraftActorJournalEvent {
  const payload = { phase, ...extraPayload };
  const result = db.prepare(`
    INSERT INTO minecraft_actor_events (
      resource_id, event_type, severity, actor_revision,
      request_id, decision_id, payload_json, occurred_at_ms
    ) VALUES (?, ?, 'info', ?, NULL, NULL, ?, ?)
  `).run(resourceId, eventType, revision, JSON.stringify(payload), integer(nowMs, "nowMs"));
  return {
    eventId: Number(result.lastInsertRowid),
    resourceId,
    eventType,
    severity: "info",
    actorRevision: revision,
    requestId: null,
    decisionId: null,
    payload,
    occurredAtMs: nowMs
  };
}

function text(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${label} 无效`);
  return normalized;
}

function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 无效`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 无效`);
  return value;
}

function port(value: number, label: string): number {
  const normalized = positiveInteger(value, label);
  if (normalized > 65_535) throw new Error(`${label} 无效`);
  return normalized;
}

function requireIncarnation(db: SqliteDatabase, runtimeInstanceId: string): MinecraftRuntimeIncarnationRecord {
  const row = db.prepare(`
    SELECT * FROM minecraft_runtime_incarnations WHERE runtime_instance_id = ?
  `).get(runtimeInstanceId) as IncarnationRow | undefined;
  if (!row) throw new Error(`Minecraft Runtime incarnation 不存在：${runtimeInstanceId}`);
  return mapIncarnation(row);
}

function mapIncarnation(row: IncarnationRow): MinecraftRuntimeIncarnationRecord {
  return {
    runtimeInstanceId: row.runtime_instance_id,
    resourceId: row.resource_id,
    attemptId: row.attempt_id,
    status: row.status,
    daemonPid: row.daemon_pid,
    daemonStartTicks: row.daemon_start_ticks,
    clientPid: row.client_pid,
    clientStartTicks: row.client_start_ticks,
    processGroupId: row.process_group_id,
    bootId: row.boot_id,
    socketPath: row.socket_path,
    gameDirectory: row.game_directory,
    tokenFile: row.token_file,
    bridgePort: row.bridge_port,
    startedAtMs: row.started_at_ms,
    stoppedAtMs: row.stopped_at_ms,
    exitReason: row.exit_reason
  };
}

function requireProcessFingerprint(input: {
  runtimeInstanceId: string;
  processName: "daemon" | "client";
  recordedPid: number | null;
  recordedStartTicks: string | null;
  expectedPid: number | null | undefined;
  expectedStartTicks: string | null | undefined;
}): void {
  if (input.recordedPid === null && input.recordedStartTicks === null) {
    if (input.expectedPid != null || input.expectedStartTicks != null) {
      throw new Error(`Minecraft Runtime ${input.processName} 进程指纹不匹配：${input.runtimeInstanceId}`);
    }
    return;
  }
  if (input.recordedPid === null || input.recordedStartTicks === null) {
    throw new Error(`Minecraft Runtime ${input.processName} 持久进程指纹不完整：${input.runtimeInstanceId}`);
  }
  if (input.expectedPid === undefined || input.expectedStartTicks === undefined) {
    throw new Error(`Minecraft Runtime ${input.processName} 进程指纹不能为空：${input.runtimeInstanceId}`);
  }
  if (input.expectedPid !== input.recordedPid) {
    throw new Error(`Minecraft Runtime ${input.processName} PID 指纹不匹配：${input.runtimeInstanceId}`);
  }
  if (input.expectedStartTicks !== input.recordedStartTicks) {
    throw new Error(`Minecraft Runtime ${input.processName} 启动指纹不匹配：${input.runtimeInstanceId}`);
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}
