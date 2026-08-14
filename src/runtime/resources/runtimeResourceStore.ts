import type { StateDatabase } from "#data/state/stateDatabase.ts";
import type {
  BrowserPageRecoveryState,
  MinecraftActorRecoveryState,
  RuntimeResourceKind,
  RuntimeResourceRecord,
  RuntimeResourceStatus,
  ShellSessionRecoveryState
} from "./resourceTypes.ts";

export type MinecraftActorOutboxKind = "owner_notification" | "decision_wake";

export interface MinecraftActorOutboxEntry {
  resourceId: string;
  outboxId: string;
  eventSequence: number;
  kind: MinecraftActorOutboxKind;
  payload: unknown;
  attemptCount: number;
  lastError: string | null;
  createdAtMs: number;
}

export interface NewMinecraftActorOutboxEntry {
  outboxId: string;
  eventSequence: number;
  kind: MinecraftActorOutboxKind;
  payload: unknown;
}

export class RuntimeResourceStore {
  constructor(private readonly stateDb: StateDatabase) {}

  async init(): Promise<void> {
    await this.stateDb.init();
  }

  private async getReadyDb() {
    await this.stateDb.init();
    return this.stateDb.getDb();
  }

  async list(kind?: RuntimeResourceKind): Promise<RuntimeResourceRecord[]> {
    const db = await this.getReadyDb();
    const rows = db.prepare(`
      SELECT r.resource_id, r.kind, r.status, r.owner_session_id, r.title, r.description,
             r.summary, r.created_at_ms, r.last_accessed_at_ms, r.expires_at_ms,
             bp.requested_url, bp.resolved_url, bp.backend, bp.title AS bp_title, bp.profile_id,
             ss.command, ss.cwd, ss.shell, ss.tty, ss.login,
             ma.actor_id, ma.transport_kind, ma.endpoint, ma.protocol_version,
             ma.persistent_state, ma.current_goal, ma.model_refs_json,
             ma.allow_autonomy_policy_change, ma.allow_program_deployment, ma.last_event_sequence,
             mab.server_address, mab.server_host, mab.server_port, mab.server_key,
             mab.template_id, mab.template_fingerprint, mab.identity_ref,
             mab.backend AS minecraft_backend, mab.desired_state, mab.provision_status,
             mab.provision_phase, mab.failure_code, mab.failure_message,
             mab.retry_at_ms, mab.attempt_id
      FROM runtime_resources r
      LEFT JOIN runtime_browser_pages bp ON r.resource_id = bp.resource_id
      LEFT JOIN runtime_shell_sessions ss ON r.resource_id = ss.resource_id
      LEFT JOIN runtime_minecraft_actors ma ON r.resource_id = ma.resource_id
      LEFT JOIN minecraft_actor_bindings mab ON r.resource_id = mab.resource_id
      ${kind ? "WHERE r.kind = ?" : ""}
      ORDER BY r.last_accessed_at_ms DESC
    `).all(...(kind ? [kind] : [])) as RuntimeResourceRow[];
    return rows.map(rowToRecord);
  }

  async listActive(kind?: RuntimeResourceKind): Promise<RuntimeResourceRecord[]> {
    const all = await this.list(kind);
    return all.filter((r) => r.status === "active");
  }

  async upsert(record: RuntimeResourceRecord, input: { minecraftOwnerPrincipalId?: string } = {}): Promise<void> {
    const db = await this.getReadyDb();
    const minecraftOwnerPrincipalId = record.kind === "minecraft_actor"
      ? input.minecraftOwnerPrincipalId?.trim()
      : undefined;
    if (record.kind === "minecraft_actor" && !minecraftOwnerPrincipalId) {
      throw new Error("minecraft_actor upsert requires minecraftOwnerPrincipalId");
    }
    const upsertBase = db.prepare(`
      INSERT INTO runtime_resources (
        resource_id, kind, status, owner_session_id, title, description,
        summary, created_at_ms, last_accessed_at_ms, expires_at_ms
      ) VALUES (
        @resourceId, @kind, @status, @ownerSessionId, @title, @description,
        @summary, @createdAtMs, @lastAccessedAtMs, @expiresAtMs
      )
      ON CONFLICT(resource_id) DO UPDATE SET
        kind = excluded.kind,
        status = excluded.status,
        owner_session_id = excluded.owner_session_id,
        title = excluded.title,
        description = excluded.description,
        summary = excluded.summary,
        last_accessed_at_ms = excluded.last_accessed_at_ms,
        expires_at_ms = excluded.expires_at_ms
    `);

    const deleteBrowser = db.prepare("DELETE FROM runtime_browser_pages WHERE resource_id = ?");
    const deleteShell = db.prepare("DELETE FROM runtime_shell_sessions WHERE resource_id = ?");
    const deleteMinecraftActor = db.prepare("DELETE FROM runtime_minecraft_actors WHERE resource_id = ?");
    const deleteMinecraftBinding = db.prepare("DELETE FROM minecraft_actor_bindings WHERE resource_id = ?");

    const insertBrowser = db.prepare(`
      INSERT INTO runtime_browser_pages (resource_id, requested_url, resolved_url, backend, title, profile_id)
      VALUES (@resourceId, @requestedUrl, @resolvedUrl, @backend, @title, @profileId)
    `);

    const insertShell = db.prepare(`
      INSERT INTO runtime_shell_sessions (resource_id, command, cwd, shell, tty, login)
      VALUES (@resourceId, @command, @cwd, @shell, @tty, @login)
    `);

    const insertMinecraftActor = db.prepare(`
      INSERT INTO runtime_minecraft_actors (
        resource_id, actor_id, transport_kind, endpoint, protocol_version,
        persistent_state, current_goal, model_refs_json,
        allow_autonomy_policy_change, allow_program_deployment, last_event_sequence
      ) VALUES (
        @resourceId, @actorId, @transportKind, @endpoint, @protocolVersion,
        @persistentState, @currentGoal, @modelRefsJson,
        @allowAutonomyPolicyChange, @allowProgramDeployment, @lastEventSequence
      )
    `);
    const insertMinecraftControlState = db.prepare(`
      INSERT INTO minecraft_actor_control_state (
        resource_id, owner_principal_id, revision, loop_phase, updated_at_ms
      ) VALUES (@resourceId, @ownerPrincipalId, 0, 'idle', @updatedAtMs)
      ON CONFLICT(resource_id) DO NOTHING
    `);
    const insertMinecraftBinding = db.prepare(`
      INSERT INTO minecraft_actor_bindings (
        resource_id, server_address, server_host, server_port, server_key,
        template_id, template_fingerprint, identity_ref, backend,
        desired_state, provision_status, provision_phase,
        failure_code, failure_message, retry_at_ms, attempt_id
      ) VALUES (
        @resourceId, @serverAddress, @serverHost, @serverPort, @serverKey,
        @templateId, @templateFingerprint, @identityRef, @backend,
        @desiredState, @provisionStatus, @provisionPhase,
        @failureCode, @failureMessage, @retryAtMs, @attemptId
      )
    `);

    const upsert = db.transaction(() => {
      upsertBase.run({
        resourceId: record.resourceId,
        kind: record.kind,
        status: record.status,
        ownerSessionId: record.ownerSessionId,
        title: record.title,
        description: record.description,
        summary: record.summary,
        createdAtMs: record.createdAtMs,
        lastAccessedAtMs: record.lastAccessedAtMs,
        expiresAtMs: record.expiresAtMs
      });

      deleteBrowser.run(record.resourceId);
      deleteShell.run(record.resourceId);
      deleteMinecraftBinding.run(record.resourceId);
      deleteMinecraftActor.run(record.resourceId);

      if (record.kind === "browser_page") {
        if (!record.browserPage) {
          throw new Error("browser_page record requires browserPage data");
        }
        insertBrowser.run({
          resourceId: record.resourceId,
          requestedUrl: record.browserPage.requestedUrl,
          resolvedUrl: record.browserPage.resolvedUrl,
          backend: record.browserPage.backend,
          title: record.browserPage.title,
          profileId: record.browserPage.profileId
        });
      } else if (record.kind === "shell_session") {
        if (!record.shellSession) {
          throw new Error("shell_session record requires shellSession data");
        }
        insertShell.run({
          resourceId: record.resourceId,
          command: record.shellSession.command,
          cwd: record.shellSession.cwd,
          shell: record.shellSession.shell,
          tty: record.shellSession.tty ? 1 : 0,
          login: record.shellSession.login ? 1 : 0
        });
      } else if (record.kind === "minecraft_actor") {
        if (!record.minecraftActor) {
          throw new Error("minecraft_actor record requires minecraftActor data");
        }
        insertMinecraftActor.run({
          resourceId: record.resourceId,
          actorId: record.minecraftActor.actorId,
          transportKind: record.minecraftActor.transportKind,
          endpoint: record.minecraftActor.endpoint,
          protocolVersion: record.minecraftActor.protocolVersion,
          persistentState: record.minecraftActor.persistentState,
          currentGoal: record.minecraftActor.currentGoal,
          modelRefsJson: JSON.stringify(record.minecraftActor.modelRefs),
          allowAutonomyPolicyChange: record.minecraftActor.allowAutonomyPolicyChange ? 1 : 0,
          allowProgramDeployment: record.minecraftActor.allowProgramDeployment ? 1 : 0,
          lastEventSequence: record.minecraftActor.lastEventSequence
        });
        insertMinecraftBinding.run({ resourceId: record.resourceId, ...record.minecraftActor.binding });
        insertMinecraftControlState.run({
          resourceId: record.resourceId,
          ownerPrincipalId: minecraftOwnerPrincipalId,
          updatedAtMs: record.lastAccessedAtMs
        });
      }
    });

    upsert();
  }

  async update(resourceId: string, patch: {
    status?: RuntimeResourceStatus;
    title?: string | null;
    description?: string | null;
    summary?: string;
    lastAccessedAtMs?: number;
    expiresAtMs?: number | null;
  }): Promise<RuntimeResourceRecord | null> {
    const db = await this.getReadyDb();
    const sets: string[] = [];
    const params: Record<string, unknown> = { resourceId };
    if (patch.status !== undefined) {
      sets.push("status = @status");
      params.status = patch.status;
    }
    if (patch.title !== undefined) {
      sets.push("title = @title");
      params.title = patch.title;
    }
    if (patch.description !== undefined) {
      sets.push("description = @description");
      params.description = patch.description;
    }
    if (patch.summary !== undefined) {
      sets.push("summary = @summary");
      params.summary = patch.summary;
    }
    if (patch.lastAccessedAtMs !== undefined) {
      sets.push("last_accessed_at_ms = @lastAccessedAtMs");
      params.lastAccessedAtMs = patch.lastAccessedAtMs;
    }
    if (patch.expiresAtMs !== undefined) {
      sets.push("expires_at_ms = @expiresAtMs");
      params.expiresAtMs = patch.expiresAtMs;
    }
    if (sets.length > 0) {
      db.prepare(`
        UPDATE runtime_resources SET ${sets.join(", ")} WHERE resource_id = @resourceId
      `).run(params);
    }
    return this.getRow(resourceId);
  }

  async updateActiveMinecraftActor(
    resourceId: string,
    minecraftActor: MinecraftActorRecoveryState,
    input: { updatedAtMs: number; summary?: string }
  ): Promise<boolean> {
    const db = await this.getReadyDb();
    const updateBase = db.prepare(`
      UPDATE runtime_resources
      SET last_accessed_at_ms = @updatedAtMs,
          summary = CASE WHEN @hasSummary = 1 THEN @summary ELSE summary END
      WHERE resource_id = @resourceId AND kind = 'minecraft_actor' AND status = 'active'
    `);
    const updateActor = db.prepare(`
      UPDATE runtime_minecraft_actors
      SET actor_id = @actorId,
          transport_kind = @transportKind,
          endpoint = @endpoint,
          protocol_version = @protocolVersion,
          persistent_state = @persistentState,
          current_goal = @currentGoal,
          model_refs_json = @modelRefsJson,
          allow_autonomy_policy_change = @allowAutonomyPolicyChange,
          allow_program_deployment = @allowProgramDeployment,
          last_event_sequence = @lastEventSequence
      WHERE resource_id = @resourceId
    `);
    const updateBinding = db.prepare(`
      UPDATE minecraft_actor_bindings
      SET server_address = @serverAddress,
          server_host = @serverHost,
          server_port = @serverPort,
          server_key = @serverKey,
          template_id = @templateId,
          template_fingerprint = @templateFingerprint,
          identity_ref = @identityRef,
          backend = @backend,
          desired_state = @desiredState,
          provision_status = @provisionStatus,
          provision_phase = @provisionPhase,
          failure_code = @failureCode,
          failure_message = @failureMessage,
          retry_at_ms = @retryAtMs,
          attempt_id = @attemptId
      WHERE resource_id = @resourceId
    `);
    const update = db.transaction(() => {
      const baseResult = updateBase.run({
        resourceId,
        updatedAtMs: input.updatedAtMs,
        hasSummary: input.summary === undefined ? 0 : 1,
        summary: input.summary ?? ""
      });
      if (baseResult.changes !== 1) return false;
      const actorResult = updateActor.run({
        resourceId,
        actorId: minecraftActor.actorId,
        transportKind: minecraftActor.transportKind,
        endpoint: minecraftActor.endpoint,
        protocolVersion: minecraftActor.protocolVersion,
        persistentState: minecraftActor.persistentState,
        currentGoal: minecraftActor.currentGoal,
        modelRefsJson: JSON.stringify(minecraftActor.modelRefs),
        allowAutonomyPolicyChange: minecraftActor.allowAutonomyPolicyChange ? 1 : 0,
        allowProgramDeployment: minecraftActor.allowProgramDeployment ? 1 : 0,
        lastEventSequence: minecraftActor.lastEventSequence
      });
      if (actorResult.changes !== 1) {
        throw new Error(`Minecraft Actor 子记录不存在：${resourceId}`);
      }
      const binding = minecraftActor.binding;
      const bindingResult = updateBinding.run({
        resourceId,
        serverAddress: binding.serverAddress,
        serverHost: binding.serverHost,
        serverPort: binding.serverPort,
        serverKey: binding.serverKey,
        templateId: binding.templateId,
        templateFingerprint: binding.templateFingerprint,
        identityRef: binding.identityRef,
        backend: binding.backend,
        desiredState: binding.desiredState,
        provisionStatus: binding.provisionStatus,
        provisionPhase: binding.provisionPhase,
        failureCode: binding.failureCode,
        failureMessage: binding.failureMessage,
        retryAtMs: binding.retryAtMs,
        attemptId: binding.attemptId
      });
      if (bindingResult.changes !== 1) {
        throw new Error(`Minecraft Actor binding 不存在：${resourceId}`);
      }
      if (binding.provisionStatus !== "ready") {
        db.prepare(`
          UPDATE minecraft_actor_control_state
          SET revision = revision + 1, loop_phase = 'paused',
              last_error = @failureMessage, updated_at_ms = @updatedAtMs
          WHERE resource_id = @resourceId
            AND active_wake_id IS NULL
            AND loop_phase NOT IN ('paused', 'closed')
        `).run({
          resourceId,
          failureMessage: binding.failureMessage,
          updatedAtMs: input.updatedAtMs
        });
      }
      return true;
    });
    return update();
  }

  async recordMinecraftActorEvents(
    resourceId: string,
    lastEventSequence: number,
    entries: NewMinecraftActorOutboxEntry[],
    updatedAtMs: number
  ): Promise<boolean> {
    const db = await this.getReadyDb();
    const touchActive = db.prepare(`
      UPDATE runtime_resources
      SET last_accessed_at_ms = @updatedAtMs
      WHERE resource_id = @resourceId AND kind = 'minecraft_actor' AND status = 'active'
    `);
    const updateCursor = db.prepare(`
      UPDATE runtime_minecraft_actors
      SET last_event_sequence = MAX(last_event_sequence, @lastEventSequence)
      WHERE resource_id = @resourceId
    `);
    const insertOutbox = db.prepare(`
      INSERT INTO runtime_minecraft_actor_outbox (
        resource_id, outbox_id, event_sequence, kind, payload_json,
        status, attempt_count, last_error, created_at_ms, delivered_at_ms
      ) VALUES (
        @resourceId, @outboxId, @eventSequence, @kind, @payloadJson,
        'pending', 0, NULL, @createdAtMs, NULL
      )
      ON CONFLICT(resource_id, outbox_id) DO NOTHING
    `);
    const record = db.transaction(() => {
      if (touchActive.run({ resourceId, updatedAtMs }).changes !== 1) return false;
      if (updateCursor.run({ resourceId, lastEventSequence }).changes !== 1) {
        throw new Error(`Minecraft Actor 子记录不存在：${resourceId}`);
      }
      for (const entry of entries) {
        insertOutbox.run({
          resourceId,
          outboxId: entry.outboxId,
          eventSequence: entry.eventSequence,
          kind: entry.kind,
          payloadJson: JSON.stringify(entry.payload),
          createdAtMs: updatedAtMs
        });
      }
      return true;
    });
    return record();
  }

  async listPendingMinecraftActorOutbox(
    resourceId: string,
    limit = 64
  ): Promise<MinecraftActorOutboxEntry[]> {
    const db = await this.getReadyDb();
    const boundedLimit = Math.min(Math.max(limit, 1), 256);
    const rows = db.prepare(`
      SELECT resource_id, outbox_id, event_sequence, kind, payload_json,
             attempt_count, last_error, created_at_ms
      FROM runtime_minecraft_actor_outbox
      WHERE resource_id = ? AND status = 'pending'
      ORDER BY event_sequence ASC,
               CASE kind WHEN 'owner_notification' THEN 0 ELSE 1 END ASC,
               outbox_id ASC
      LIMIT ?
    `).all(resourceId, boundedLimit) as MinecraftActorOutboxRow[];
    return rows.map(row => ({
      resourceId: row.resource_id,
      outboxId: row.outbox_id,
      eventSequence: row.event_sequence,
      kind: row.kind,
      payload: parseOutboxPayload(row.payload_json, row.outbox_id),
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      createdAtMs: row.created_at_ms
    }));
  }

  async markMinecraftActorOutboxDelivered(
    resourceId: string,
    outboxId: string,
    deliveredAtMs: number
  ): Promise<boolean> {
    const db = await this.getReadyDb();
    return db.prepare(`
      UPDATE runtime_minecraft_actor_outbox
      SET status = 'delivered', delivered_at_ms = ?, last_error = NULL
      WHERE resource_id = ? AND outbox_id = ? AND status = 'pending'
    `).run(deliveredAtMs, resourceId, outboxId).changes === 1;
  }

  async markMinecraftActorOutboxFailed(resourceId: string, outboxId: string, error: string): Promise<void> {
    const db = await this.getReadyDb();
    db.prepare(`
      UPDATE runtime_minecraft_actor_outbox
      SET attempt_count = attempt_count + 1, last_error = ?
      WHERE resource_id = ? AND outbox_id = ? AND status = 'pending'
    `).run(error.slice(0, 4_000), resourceId, outboxId);
  }

  async getRow(resourceId: string): Promise<RuntimeResourceRecord | null> {
    const db = await this.getReadyDb();
    const row = db.prepare(`
      SELECT r.resource_id, r.kind, r.status, r.owner_session_id, r.title, r.description,
             r.summary, r.created_at_ms, r.last_accessed_at_ms, r.expires_at_ms,
             bp.requested_url, bp.resolved_url, bp.backend, bp.title AS bp_title, bp.profile_id,
             ss.command, ss.cwd, ss.shell, ss.tty, ss.login,
             ma.actor_id, ma.transport_kind, ma.endpoint, ma.protocol_version,
             ma.persistent_state, ma.current_goal, ma.model_refs_json,
             ma.allow_autonomy_policy_change, ma.allow_program_deployment, ma.last_event_sequence,
             mab.server_address, mab.server_host, mab.server_port, mab.server_key,
             mab.template_id, mab.template_fingerprint, mab.identity_ref,
             mab.backend AS minecraft_backend, mab.desired_state, mab.provision_status,
             mab.provision_phase, mab.failure_code, mab.failure_message,
             mab.retry_at_ms, mab.attempt_id
      FROM runtime_resources r
      LEFT JOIN runtime_browser_pages bp ON r.resource_id = bp.resource_id
      LEFT JOIN runtime_shell_sessions ss ON r.resource_id = ss.resource_id
      LEFT JOIN runtime_minecraft_actors ma ON r.resource_id = ma.resource_id
      LEFT JOIN minecraft_actor_bindings mab ON r.resource_id = mab.resource_id
      WHERE r.resource_id = ?
    `).get(resourceId) as RuntimeResourceRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async reset(): Promise<void> {
    const db = await this.getReadyDb();
    db.prepare("DELETE FROM runtime_browser_pages").run();
    db.prepare("DELETE FROM runtime_shell_sessions").run();
    db.prepare("DELETE FROM runtime_minecraft_actors").run();
    db.prepare("DELETE FROM runtime_resources").run();
  }

  async resetEphemeral(): Promise<void> {
    const db = await this.getReadyDb();
    db.prepare("DELETE FROM runtime_resources WHERE kind IN ('browser_page', 'shell_session')").run();
  }

  async listRows(input: { offset?: number; limit?: number } = {}): Promise<{ rows: unknown[]; total: number; offset: number; limit: number }> {
    const all = await this.list();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    return {
      rows: all.slice(offset, offset + limit),
      total: all.length,
      offset,
      limit
    };
  }

  async listBrowserPageRows(input: { offset?: number; limit?: number; filters?: Record<string, unknown> } = {}): Promise<{
    rows: Array<{ resourceId: string; requestedUrl: string; resolvedUrl: string; backend: string; title: string | null; profileId: string | null }>;
    total: number;
    offset: number;
    limit: number;
  }> {
    const db = await this.getReadyDb();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    const resourceId = typeof input.filters?.resourceId === "string" && input.filters.resourceId.trim()
      ? input.filters.resourceId.trim()
      : null;
    const whereSql = resourceId ? "WHERE resource_id = ?" : "";
    const params = resourceId ? [resourceId] : [];
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM runtime_browser_pages ${whereSql}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`
      SELECT
        resource_id AS resourceId,
        requested_url AS requestedUrl,
        resolved_url AS resolvedUrl,
        backend,
        title,
        profile_id AS profileId
      FROM runtime_browser_pages
      ${whereSql}
      ORDER BY resource_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{ resourceId: string; requestedUrl: string; resolvedUrl: string; backend: string; title: string | null; profileId: string | null }>;
    return { rows, total, offset, limit };
  }

  async listShellSessionRows(input: { offset?: number; limit?: number; filters?: Record<string, unknown> } = {}): Promise<{
    rows: Array<{ resourceId: string; command: string; cwd: string; shell: string; tty: boolean; login: boolean }>;
    total: number;
    offset: number;
    limit: number;
  }> {
    const db = await this.getReadyDb();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    const resourceId = typeof input.filters?.resourceId === "string" && input.filters.resourceId.trim()
      ? input.filters.resourceId.trim()
      : null;
    const whereSql = resourceId ? "WHERE resource_id = ?" : "";
    const params = resourceId ? [resourceId] : [];
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM runtime_shell_sessions ${whereSql}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`
      SELECT
        resource_id AS resourceId,
        command,
        cwd,
        shell,
        tty,
        login
      FROM runtime_shell_sessions
      ${whereSql}
      ORDER BY resource_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{ resourceId: string; command: string; cwd: string; shell: string; tty: 0 | 1; login: 0 | 1 }>;
    return {
      rows: rows.map((row) => ({ ...row, tty: row.tty === 1, login: row.login === 1 })),
      total,
      offset,
      limit
    };
  }

  async listMinecraftActorRows(input: { offset?: number; limit?: number; filters?: Record<string, unknown> } = {}): Promise<{
    rows: Array<{
      resourceId: string;
      actorId: string;
      transportKind: MinecraftActorRecoveryState["transportKind"];
      endpoint: string;
      protocolVersion: 1;
      persistentState: string;
      currentGoal: string | null;
      modelRefs: string[];
      allowAutonomyPolicyChange: boolean;
      allowProgramDeployment: boolean;
      lastEventSequence: number;
    }>;
    total: number;
    offset: number;
    limit: number;
  }> {
    const db = await this.getReadyDb();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    const resourceId = typeof input.filters?.resourceId === "string" && input.filters.resourceId.trim()
      ? input.filters.resourceId.trim()
      : null;
    const whereSql = resourceId ? "WHERE resource_id = ?" : "";
    const params = resourceId ? [resourceId] : [];
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM runtime_minecraft_actors ${whereSql}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`
      SELECT
        resource_id AS resourceId,
        actor_id AS actorId,
        transport_kind AS transportKind,
        endpoint,
        protocol_version AS protocolVersion,
        persistent_state AS persistentState,
        current_goal AS currentGoal,
        model_refs_json AS modelRefsJson,
        allow_autonomy_policy_change AS allowAutonomyPolicyChange,
        allow_program_deployment AS allowProgramDeployment,
        last_event_sequence AS lastEventSequence
      FROM runtime_minecraft_actors
      ${whereSql}
      ORDER BY resource_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{
      resourceId: string;
      actorId: string;
      transportKind: MinecraftActorRecoveryState["transportKind"];
      endpoint: string;
      protocolVersion: 1;
      persistentState: string;
      currentGoal: string | null;
      modelRefsJson: string;
      allowAutonomyPolicyChange: 0 | 1;
      allowProgramDeployment: 0 | 1;
      lastEventSequence: number;
    }>;
    return {
      rows: rows.map(({ modelRefsJson, ...row }) => ({
        ...row,
        modelRefs: parseModelRefs(modelRefsJson),
        allowAutonomyPolicyChange: row.allowAutonomyPolicyChange === 1,
        allowProgramDeployment: row.allowProgramDeployment === 1
      })),
      total,
      offset,
      limit
    };
  }
}

interface MinecraftActorOutboxRow {
  resource_id: string;
  outbox_id: string;
  event_sequence: number;
  kind: MinecraftActorOutboxKind;
  payload_json: string;
  attempt_count: number;
  last_error: string | null;
  created_at_ms: number;
}

function parseOutboxPayload(raw: string, outboxId: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Minecraft Actor outbox ${outboxId} payload 无效`, { cause: error });
  }
}

interface RuntimeResourceRow {
  resource_id: string;
  kind: string;
  status: string;
  owner_session_id: string | null;
  title: string | null;
  description: string | null;
  summary: string;
  created_at_ms: number;
  last_accessed_at_ms: number;
  expires_at_ms: number | null;
  requested_url: string | null;
  resolved_url: string | null;
  backend: string | null;
  bp_title: string | null;
  profile_id: string | null;
  command: string | null;
  cwd: string | null;
  shell: string | null;
  tty: number | null;
  login: number | null;
  actor_id: string | null;
  transport_kind: string | null;
  endpoint: string | null;
  protocol_version: number | null;
  persistent_state: string | null;
  current_goal: string | null;
  model_refs_json: string | null;
  allow_autonomy_policy_change: number | null;
  allow_program_deployment: number | null;
  last_event_sequence: number | null;
  server_address: string | null;
  server_host: string | null;
  server_port: number | null;
  server_key: string | null;
  template_id: string | null;
  template_fingerprint: string | null;
  identity_ref: string | null;
  minecraft_backend: string | null;
  desired_state: string | null;
  provision_status: string | null;
  provision_phase: string | null;
  failure_code: string | null;
  failure_message: string | null;
  retry_at_ms: number | null;
  attempt_id: string | null;
}

function rowToRecord(row: RuntimeResourceRow): RuntimeResourceRecord {
  const record: RuntimeResourceRecord = {
    resourceId: row.resource_id,
    kind: row.kind as RuntimeResourceKind,
    status: row.status as RuntimeResourceStatus,
    ownerSessionId: row.owner_session_id,
    title: row.title,
    description: row.description,
    summary: row.summary,
    createdAtMs: row.created_at_ms,
    lastAccessedAtMs: row.last_accessed_at_ms,
    expiresAtMs: row.expires_at_ms
  };
  if (row.kind === "browser_page" && row.requested_url) {
    record.browserPage = {
      requestedUrl: row.requested_url,
      resolvedUrl: row.resolved_url ?? row.requested_url,
      backend: (row.backend as "playwright") ?? "playwright",
      title: row.bp_title ?? null,
      profileId: row.profile_id ?? null
    };
  }
  if (row.kind === "shell_session" && row.command) {
    record.shellSession = {
      command: row.command,
      cwd: row.cwd ?? "",
      shell: row.shell ?? "",
      tty: row.tty === 1,
      login: row.login === 1
    };
  }
  if (row.kind === "minecraft_actor" && row.actor_id && row.endpoint && row.server_address) {
    record.minecraftActor = {
      actorId: row.actor_id,
      transportKind: row.transport_kind as MinecraftActorRecoveryState["transportKind"],
      endpoint: row.endpoint,
      protocolVersion: 1,
      persistentState: row.persistent_state ?? "",
      currentGoal: row.current_goal,
      modelRefs: parseModelRefs(row.model_refs_json),
      allowAutonomyPolicyChange: row.allow_autonomy_policy_change === 1,
      allowProgramDeployment: row.allow_program_deployment === 1,
      lastEventSequence: row.last_event_sequence ?? 0,
      binding: {
        serverAddress: row.server_address,
        serverHost: row.server_host ?? "",
        serverPort: row.server_port ?? 25565,
        serverKey: row.server_key ?? row.server_address,
        templateId: row.template_id ?? "",
        templateFingerprint: row.template_fingerprint ?? "",
        identityRef: row.identity_ref ?? "",
        backend: row.minecraft_backend as MinecraftActorRecoveryState["binding"]["backend"],
        desiredState: row.desired_state as MinecraftActorRecoveryState["binding"]["desiredState"],
        provisionStatus: row.provision_status as MinecraftActorRecoveryState["binding"]["provisionStatus"],
        provisionPhase: row.provision_phase as MinecraftActorRecoveryState["binding"]["provisionPhase"],
        failureCode: row.failure_code,
        failureMessage: row.failure_message,
        retryAtMs: row.retry_at_ms,
        attemptId: row.attempt_id
      }
    };
  }
  return record;
}

function parseModelRefs(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    if (Array.isArray(parsed) && parsed.every(item => typeof item === "string" && item.trim().length > 0)) {
      return parsed;
    }
  } catch {
    // Corrupt cache rows are surfaced as an empty model list and cannot start decisions.
  }
  return [];
}
