import { join } from "node:path";
import type { Logger } from "pino";
import {
  assertTableColumns,
  SqliteService,
  type SqliteDatabase,
  type SqliteDatabaseHandle,
  type SqliteTableGroupDefinition
} from "#data/sqlite/sqliteService.ts";

export class StateDatabase {
  private readonly dbPath: string;
  private sqlite: SqliteDatabaseHandle | null = null;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly sqliteService = new SqliteService(logger)
  ) {
    this.dbPath = join(dataDir, "state", "state.sqlite");
  }

  async init(): Promise<void> {
    if (this.sqlite) {
      return;
    }
    this.sqlite = await this.sqliteService.openDatabase({
      databaseId: "state",
      dbPath: this.dbPath,
      tableGroups: STATE_TABLE_GROUPS,
      pragmas: {
        wal: true,
        foreignKeys: true,
        busyTimeoutMs: 5000
      },
      selfHealing: {
        resetDatabaseOnOpenFailure: false,
        resetDatabaseOnIntegrityFailure: false,
        backupInvalidDatabase: false
      }
    });
  }

  getDb(): SqliteDatabase {
    const db = this.sqlite?.db;
    if (!db) {
      throw new Error("State database is not initialized");
    }
    return db;
  }

  getStatus(): ReturnType<SqliteDatabaseHandle["getStatus"]> | null {
    return this.sqlite?.getStatus() ?? null;
  }

  close(): void {
    this.sqlite?.close();
    this.sqlite = null;
  }
}

function createPersonaSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS persona (
      id TEXT PRIMARY KEY CHECK (id = 'global'),
      name TEXT NOT NULL DEFAULT '',
      temperament TEXT NOT NULL DEFAULT '',
      voice_style TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function validatePersonaSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "persona", {
    id: "TEXT",
    name: "TEXT",
    temperament: "TEXT",
    voice_style: "TEXT",
    updated_at_ms: "INTEGER"
  });
}

function migratePersonaSchema(db: SqliteDatabase): boolean {
  const row = db.prepare(`
    SELECT
      name,
      temperament,
      speaking_style AS speakingStyle,
      updated_at_ms AS updatedAtMs
    FROM persona
    WHERE id = 'global'
  `).get() as {
    name?: string;
    temperament?: string;
    speakingStyle?: string;
    updatedAtMs?: number;
  } | undefined;
  db.exec("DROP TABLE IF EXISTS persona;");
  createPersonaSchema(db);
  if (row) {
    db.prepare(`
      INSERT INTO persona (id, name, temperament, voice_style, updated_at_ms)
      VALUES ('global', @name, @temperament, @voiceStyle, @updatedAtMs)
    `).run({
      name: row.name ?? "",
      temperament: row.temperament ?? "",
      voiceStyle: row.speakingStyle ?? "",
      updatedAtMs: row.updatedAtMs ?? Date.now()
    });
  }
  return true;
}

function createWhitelistSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whitelist_entries (
      target_type TEXT NOT NULL CHECK (target_type IN ('user', 'group')),
      target_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      PRIMARY KEY (target_type, target_id)
    );
  `);
}

function validateWhitelistSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "whitelist_entries", {
    target_type: "TEXT",
    target_id: "TEXT",
    created_at_ms: "INTEGER"
  });
}

function createRpProfileSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rp_profile (
      id TEXT PRIMARY KEY CHECK (id = 'global'),
      identity TEXT NOT NULL DEFAULT '',
      background TEXT NOT NULL DEFAULT '',
      continuity_facts TEXT NOT NULL DEFAULT '',
      boundaries TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function validateRpProfileSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "rp_profile", {
    id: "TEXT",
    identity: "TEXT",
    background: "TEXT",
    continuity_facts: "TEXT",
    boundaries: "TEXT",
    updated_at_ms: "INTEGER"
  });
}

function migrateRpProfileSchema(db: SqliteDatabase): boolean {
  const row = db.prepare(`
    SELECT
      self_positioning AS selfPositioning,
      social_role AS socialRole,
      life_context AS lifeContext,
      physical_presence AS physicalPresence,
      reality_contract AS realityContract,
      continuity_facts AS continuityFacts,
      hard_limits AS hardLimits,
      updated_at_ms AS updatedAtMs
    FROM rp_profile
    WHERE id = 'global'
  `).get() as {
    selfPositioning?: string;
    socialRole?: string;
    lifeContext?: string;
    physicalPresence?: string;
    realityContract?: string;
    continuityFacts?: string;
    hardLimits?: string;
    updatedAtMs?: number;
  } | undefined;
  db.exec("DROP TABLE IF EXISTS rp_profile;");
  createRpProfileSchema(db);
  if (row) {
    db.prepare(`
      INSERT INTO rp_profile (id, identity, background, continuity_facts, boundaries, updated_at_ms)
      VALUES ('global', @identity, @background, @continuityFacts, @boundaries, @updatedAtMs)
    `).run({
      identity: joinNonEmpty([row.selfPositioning, row.socialRole]),
      background: joinNonEmpty([row.lifeContext, row.physicalPresence]),
      continuityFacts: row.continuityFacts ?? "",
      boundaries: joinNonEmpty([row.hardLimits, row.realityContract]),
      updatedAtMs: row.updatedAtMs ?? Date.now()
    });
  }
  return true;
}

function joinNonEmpty(values: Array<string | undefined>): string {
  return values
    .map((value) => value?.trim() ?? "")
    .filter(Boolean)
    .join("；");
}

function createGlobalProfileReadinessSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_profile_readiness (
      id TEXT PRIMARY KEY CHECK (id = 'global'),
      persona TEXT NOT NULL CHECK (persona IN ('uninitialized', 'ready')),
      rp TEXT NOT NULL CHECK (rp IN ('uninitialized', 'ready')),
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function validateGlobalProfileReadinessSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "global_profile_readiness", {
    id: "TEXT",
    persona: "TEXT",
    rp: "TEXT",
    updated_at_ms: "INTEGER"
  });
}

function migrateGlobalProfileReadinessSchema(db: SqliteDatabase): boolean {
  const row = db.prepare(`
    SELECT
      persona,
      rp,
      updated_at_ms AS updatedAtMs
    FROM global_profile_readiness
    WHERE id = 'global'
  `).get() as {
    persona?: string;
    rp?: string;
    updatedAtMs?: number;
  } | undefined;
  db.exec("DROP TABLE IF EXISTS global_profile_readiness;");
  createGlobalProfileReadinessSchema(db);
  if (row) {
    db.prepare(`
      INSERT INTO global_profile_readiness (id, persona, rp, updated_at_ms)
      VALUES ('global', @persona, @rp, @updatedAtMs)
    `).run({
      persona: row.persona === "ready" ? "ready" : "uninitialized",
      rp: row.rp === "ready" ? "ready" : "uninitialized",
      updatedAtMs: row.updatedAtMs ?? Date.now()
    });
  }
  return true;
}

function createSetupStateSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS setup_state (
      id TEXT PRIMARY KEY CHECK (id = 'global'),
      state TEXT NOT NULL CHECK (state IN ('needs_owner', 'needs_persona', 'ready')),
      owner_prompt_sent_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function validateSetupStateSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "setup_state", {
    id: "TEXT",
    state: "TEXT",
    owner_prompt_sent_at_ms: "INTEGER",
    updated_at_ms: "INTEGER"
  });
}

function createUsersSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY NOT NULL CHECK (user_id = trim(user_id) AND length(user_id) > 0),
      preferred_address TEXT,
      gender TEXT,
      residence TEXT,
      timezone TEXT,
      occupation TEXT,
      profile_summary TEXT,
      relationship_note TEXT,
      special_role TEXT CHECK (special_role IS NULL OR special_role IN ('npc')),
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_memories (
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'boundary', 'habit', 'relationship', 'other')),
      source TEXT NOT NULL CHECK (source IN ('user_explicit', 'owner_explicit', 'inferred')),
      importance INTEGER CHECK (importance IS NULL OR (importance >= 1 AND importance <= 5)),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL,
      last_used_at_ms INTEGER,
      PRIMARY KEY (user_id, id)
    );
  `);
}

function validateUsersSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "users", {
    user_id: "TEXT",
    preferred_address: "TEXT",
    gender: "TEXT",
    residence: "TEXT",
    timezone: "TEXT",
    occupation: "TEXT",
    profile_summary: "TEXT",
    relationship_note: "TEXT",
    special_role: "TEXT",
    created_at_ms: "INTEGER"
  });
  assertTableColumns(db, "user_memories", {
    user_id: "TEXT",
    id: "TEXT",
    title: "TEXT",
    content: "TEXT",
    kind: "TEXT",
    source: "TEXT",
    importance: "INTEGER",
    created_at_ms: "INTEGER",
    updated_at_ms: "INTEGER",
    last_used_at_ms: "INTEGER"
  });
}

function createRequestsSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_requests (
      flag TEXT PRIMARY KEY NOT NULL CHECK (flag = trim(flag) AND length(flag) > 0),
      kind TEXT NOT NULL CHECK (kind IN ('friend', 'group')),
      user_id TEXT NOT NULL CHECK (user_id = trim(user_id) AND length(user_id) > 0),
      group_id TEXT CHECK (group_id IS NULL OR (group_id = trim(group_id) AND length(group_id) > 0)),
      sub_type TEXT CHECK (sub_type IS NULL OR sub_type IN ('add', 'invite')),
      comment TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      CHECK (
        (kind = 'friend' AND group_id IS NULL AND sub_type IS NULL)
        OR
        (kind = 'group' AND group_id IS NOT NULL AND sub_type IS NOT NULL)
      )
    );
  `);
}

function validateRequestsSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "pending_requests", {
    flag: "TEXT",
    kind: "TEXT",
    user_id: "TEXT",
    group_id: "TEXT",
    sub_type: "TEXT",
    comment: "TEXT",
    created_at_ms: "INTEGER",
    sort_order: "INTEGER"
  });
}

function createScheduledJobsSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id TEXT PRIMARY KEY NOT NULL CHECK (id = trim(id) AND length(id) > 0),
      name TEXT NOT NULL CHECK (name = trim(name) AND length(name) > 0),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('delay', 'at', 'cron')),
      schedule_delay_ms INTEGER,
      schedule_run_at_ms INTEGER,
      schedule_cron_expr TEXT,
      schedule_timezone TEXT,
      instruction TEXT NOT NULL CHECK (instruction = trim(instruction) AND length(instruction) > 0),
      next_run_at_ms INTEGER,
      last_run_at_ms INTEGER,
      last_run_status TEXT CHECK (last_run_status IN ('ok', 'error', 'running')),
      last_duration_ms INTEGER,
      last_error TEXT,
      consecutive_errors INTEGER NOT NULL CHECK (consecutive_errors >= 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0)
    );

    CREATE TABLE IF NOT EXISTS scheduled_job_targets (
      job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL CHECK (session_id = trim(session_id) AND length(session_id) > 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      PRIMARY KEY (job_id, session_id)
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_job_targets_job_order ON scheduled_job_targets(job_id, sort_order);");
}

function validateScheduledJobsSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "scheduled_jobs", {
    id: "TEXT",
    name: "TEXT",
    enabled: "INTEGER",
    created_at_ms: "INTEGER",
    updated_at_ms: "INTEGER",
    schedule_kind: "TEXT",
    schedule_delay_ms: "INTEGER",
    schedule_run_at_ms: "INTEGER",
    schedule_cron_expr: "TEXT",
    schedule_timezone: "TEXT",
    instruction: "TEXT",
    next_run_at_ms: "INTEGER",
    last_run_at_ms: "INTEGER",
    last_run_status: "TEXT",
    last_duration_ms: "INTEGER",
    last_error: "TEXT",
    consecutive_errors: "INTEGER",
    sort_order: "INTEGER"
  });
  assertTableColumns(db, "scheduled_job_targets", {
    job_id: "TEXT",
    session_id: "TEXT",
    sort_order: "INTEGER"
  });
}

function createRulesSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_rules (
      id TEXT PRIMARY KEY NOT NULL CHECK (id = trim(id) AND length(id) > 0),
      title TEXT NOT NULL CHECK (title = trim(title) AND length(title) > 0),
      content TEXT NOT NULL CHECK (content = trim(content) AND length(content) > 0),
      kind TEXT NOT NULL CHECK (kind IN ('workflow', 'constraint', 'preference', 'other')),
      source TEXT NOT NULL CHECK (source IN ('owner_explicit', 'inferred')),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0)
    );

    CREATE TABLE IF NOT EXISTS toolset_rules (
      id TEXT PRIMARY KEY NOT NULL CHECK (id = trim(id) AND length(id) > 0),
      title TEXT NOT NULL CHECK (title = trim(title) AND length(title) > 0),
      content TEXT NOT NULL CHECK (content = trim(content) AND length(content) > 0),
      fingerprint TEXT NOT NULL CHECK (fingerprint = trim(fingerprint) AND length(fingerprint) > 0),
      source TEXT NOT NULL CHECK (source IN ('owner_explicit', 'inferred')),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0)
    );

    CREATE TABLE IF NOT EXISTS toolset_rule_toolsets (
      rule_id TEXT NOT NULL REFERENCES toolset_rules(id) ON DELETE CASCADE,
      toolset_id TEXT NOT NULL CHECK (toolset_id = trim(toolset_id) AND length(toolset_id) > 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      PRIMARY KEY (rule_id, toolset_id)
    );
  `);
}

function validateRulesSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "global_rules", {
    id: "TEXT",
    title: "TEXT",
    content: "TEXT",
    kind: "TEXT",
    source: "TEXT",
    created_at_ms: "INTEGER",
    updated_at_ms: "INTEGER",
    sort_order: "INTEGER"
  });
  assertTableColumns(db, "toolset_rules", {
    id: "TEXT",
    title: "TEXT",
    content: "TEXT",
    fingerprint: "TEXT",
    source: "TEXT",
    created_at_ms: "INTEGER",
    updated_at_ms: "INTEGER",
    sort_order: "INTEGER"
  });
  assertTableColumns(db, "toolset_rule_toolsets", {
    rule_id: "TEXT",
    toolset_id: "TEXT",
    sort_order: "INTEGER"
  });
}

function createUserIdentitiesSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_identities (
      channel_id TEXT NOT NULL CHECK (channel_id = trim(channel_id) AND length(channel_id) > 0),
      scope TEXT NOT NULL CHECK (scope IN ('private_user')),
      external_id TEXT NOT NULL CHECK (external_id = trim(external_id) AND length(external_id) > 0),
      internal_user_id TEXT NOT NULL CHECK (internal_user_id = trim(internal_user_id) AND length(internal_user_id) > 0),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      PRIMARY KEY (channel_id, scope, external_id),
      UNIQUE (internal_user_id)
    );
  `);
}

function validateUserIdentitiesSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "user_identities", {
    channel_id: "TEXT",
    scope: "TEXT",
    external_id: "TEXT",
    internal_user_id: "TEXT",
    created_at_ms: "INTEGER"
  });
}

function createGroupMembershipSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_membership_entries (
      group_id TEXT NOT NULL CHECK (group_id = trim(group_id) AND length(group_id) > 0),
      user_id TEXT NOT NULL CHECK (user_id = trim(user_id) AND length(user_id) > 0),
      is_member INTEGER NOT NULL CHECK (is_member IN (0, 1)),
      verified_at_ms INTEGER NOT NULL CHECK (verified_at_ms >= 0),
      PRIMARY KEY (group_id, user_id)
    );
  `);
}

function validateGroupMembershipSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "group_membership_entries", {
    group_id: "TEXT",
    user_id: "TEXT",
    is_member: "INTEGER",
    verified_at_ms: "INTEGER"
  });
}

function createRuntimeResourcesSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_resources (
      resource_id TEXT PRIMARY KEY NOT NULL CHECK (resource_id = trim(resource_id) AND length(resource_id) > 0),
      kind TEXT NOT NULL CHECK (kind IN ('browser_page', 'shell_session', 'minecraft_actor')),
      status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'closed', 'unrecoverable')),
      owner_session_id TEXT,
      title TEXT,
      description TEXT,
      summary TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      last_accessed_at_ms INTEGER NOT NULL CHECK (last_accessed_at_ms >= 0),
      expires_at_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS runtime_browser_pages (
      resource_id TEXT PRIMARY KEY NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
      requested_url TEXT NOT NULL,
      resolved_url TEXT NOT NULL,
      backend TEXT NOT NULL CHECK (backend = 'playwright'),
      title TEXT,
      profile_id TEXT
    );

    CREATE TABLE IF NOT EXISTS runtime_shell_sessions (
      resource_id TEXT PRIMARY KEY NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      shell TEXT NOT NULL,
      tty INTEGER NOT NULL CHECK (tty IN (0, 1)),
      login INTEGER NOT NULL CHECK (login IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS runtime_minecraft_actors (
      resource_id TEXT PRIMARY KEY NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL CHECK (actor_id = trim(actor_id) AND length(actor_id) > 0),
      transport_kind TEXT NOT NULL CHECK (transport_kind IN ('unix_socket', 'loopback_tcp', 'in_process')),
      endpoint TEXT NOT NULL CHECK (endpoint = trim(endpoint) AND length(endpoint) > 0),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
      persistent_state TEXT NOT NULL DEFAULT '',
      current_goal TEXT,
      model_refs_json TEXT NOT NULL DEFAULT '[]',
      allow_autonomy_policy_change INTEGER NOT NULL CHECK (allow_autonomy_policy_change IN (0, 1)),
      allow_program_deployment INTEGER NOT NULL CHECK (allow_program_deployment IN (0, 1)),
      last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 0)
    );

    CREATE TABLE IF NOT EXISTS runtime_minecraft_actor_outbox (
      resource_id TEXT NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
      outbox_id TEXT NOT NULL CHECK (outbox_id = trim(outbox_id) AND length(outbox_id) > 0),
      event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
      kind TEXT NOT NULL CHECK (kind IN ('owner_notification', 'decision_wake')),
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      delivered_at_ms INTEGER,
      PRIMARY KEY (resource_id, outbox_id)
    );

    CREATE TABLE IF NOT EXISTS minecraft_actor_control_state (
      resource_id TEXT PRIMARY KEY NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
      owner_principal_id TEXT NOT NULL CHECK (owner_principal_id = trim(owner_principal_id) AND length(owner_principal_id) > 0),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      loop_phase TEXT NOT NULL DEFAULT 'idle' CHECK (loop_phase IN ('idle', 'queued', 'deciding', 'paused', 'error', 'closed')),
      active_wake_id TEXT,
      active_decision_id TEXT,
      last_error TEXT,
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
    );

    CREATE TABLE IF NOT EXISTS minecraft_actor_requests (
      resource_id TEXT NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
      request_id TEXT NOT NULL CHECK (request_id = trim(request_id) AND length(request_id) > 0),
      idempotency_key TEXT NOT NULL CHECK (idempotency_key = trim(idempotency_key) AND length(idempotency_key) > 0),
      fingerprint TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      owner_session_id TEXT NOT NULL,
      instruction TEXT NOT NULL CHECK (instruction = trim(instruction) AND length(instruction) > 0),
      constraints_text TEXT,
      priority TEXT NOT NULL CHECK (priority IN ('normal', 'high')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
      decision_id TEXT,
      result_summary TEXT,
      error TEXT,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      PRIMARY KEY (resource_id, request_id),
      UNIQUE (resource_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS minecraft_actor_wake_mailbox (
      resource_id TEXT NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
      wake_id TEXT NOT NULL CHECK (wake_id = trim(wake_id) AND length(wake_id) > 0),
      source_type TEXT NOT NULL CHECK (source_type IN ('owner_request', 'runtime_event', 'manual', 'autonomy')),
      source_id TEXT NOT NULL CHECK (source_id = trim(source_id) AND length(source_id) > 0),
      fingerprint TEXT NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('normal', 'high', 'critical')),
      wake_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted', 'dead_letter')),
      decision_id TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at_ms INTEGER NOT NULL CHECK (next_attempt_at_ms >= 0),
      last_error TEXT,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      completed_at_ms INTEGER,
      PRIMARY KEY (resource_id, wake_id),
      UNIQUE (resource_id, source_type, source_id)
    );

    CREATE TABLE IF NOT EXISTS minecraft_actor_decisions (
      resource_id TEXT NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
      decision_id TEXT NOT NULL CHECK (decision_id = trim(decision_id) AND length(decision_id) > 0),
      wake_id TEXT NOT NULL,
      request_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'dead_letter')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      wake_type TEXT NOT NULL,
      wake_summary TEXT NOT NULL,
      decision_summary TEXT,
      error TEXT,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      PRIMARY KEY (resource_id, decision_id),
      UNIQUE (resource_id, wake_id)
    );

    CREATE TABLE IF NOT EXISTS minecraft_actor_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_id TEXT NOT NULL REFERENCES runtime_resources(resource_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warning', 'critical')),
      actor_revision INTEGER NOT NULL CHECK (actor_revision >= 0),
      request_id TEXT,
      decision_id TEXT,
      payload_json TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_minecraft_actor_requests_status
      ON minecraft_actor_requests(resource_id, status, created_at_ms, request_id);
    CREATE INDEX IF NOT EXISTS idx_minecraft_actor_wake_pending
      ON minecraft_actor_wake_mailbox(resource_id, status, next_attempt_at_ms, priority, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_minecraft_actor_events_cursor
      ON minecraft_actor_events(resource_id, event_id);
  `);

  db.prepare(`
    INSERT INTO minecraft_actor_control_state (
      resource_id, owner_principal_id, revision, loop_phase, updated_at_ms
    )
    SELECT resource_id, COALESCE(NULLIF(owner_session_id, ''), 'legacy-owner'), 0, 'idle', last_accessed_at_ms
    FROM runtime_resources
    WHERE kind = 'minecraft_actor'
    ON CONFLICT(resource_id) DO NOTHING
  `).run();
}

function migrateRuntimeResourcesSchema(db: SqliteDatabase): boolean {
  const hasMinecraftActors = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_minecraft_actors'
  `).get() !== undefined;
  if (hasMinecraftActors) {
    createRuntimeResourcesSchema(db);
    return true;
  }

  const resources = db.prepare("SELECT * FROM runtime_resources").all() as Array<Record<string, unknown>>;
  const browserPages = db.prepare("SELECT * FROM runtime_browser_pages").all() as Array<Record<string, unknown>>;
  const shellSessions = db.prepare("SELECT * FROM runtime_shell_sessions").all() as Array<Record<string, unknown>>;

  db.exec(`
    DROP TABLE runtime_browser_pages;
    DROP TABLE runtime_shell_sessions;
    DROP TABLE runtime_resources;
  `);
  createRuntimeResourcesSchema(db);

  const insertResource = db.prepare(`
    INSERT INTO runtime_resources (
      resource_id, kind, status, owner_session_id, title, description,
      summary, created_at_ms, last_accessed_at_ms, expires_at_ms
    ) VALUES (
      @resource_id, @kind, @status, @owner_session_id, @title, @description,
      @summary, @created_at_ms, @last_accessed_at_ms, @expires_at_ms
    )
  `);
  const insertBrowser = db.prepare(`
    INSERT INTO runtime_browser_pages (resource_id, requested_url, resolved_url, backend, title, profile_id)
    VALUES (@resource_id, @requested_url, @resolved_url, @backend, @title, @profile_id)
  `);
  const insertShell = db.prepare(`
    INSERT INTO runtime_shell_sessions (resource_id, command, cwd, shell, tty, login)
    VALUES (@resource_id, @command, @cwd, @shell, @tty, @login)
  `);
  for (const row of resources) insertResource.run(row);
  for (const row of browserPages) insertBrowser.run(row);
  for (const row of shellSessions) insertShell.run(row);
  return true;
}

function validateRuntimeResourcesSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "runtime_resources", {
    resource_id: "TEXT",
    kind: "TEXT",
    status: "TEXT",
    owner_session_id: "TEXT",
    title: "TEXT",
    description: "TEXT",
    summary: "TEXT",
    created_at_ms: "INTEGER",
    last_accessed_at_ms: "INTEGER",
    expires_at_ms: "INTEGER"
  });
  assertTableColumns(db, "runtime_browser_pages", {
    resource_id: "TEXT",
    requested_url: "TEXT",
    resolved_url: "TEXT",
    backend: "TEXT",
    title: "TEXT",
    profile_id: "TEXT"
  });
  assertTableColumns(db, "runtime_shell_sessions", {
    resource_id: "TEXT",
    command: "TEXT",
    cwd: "TEXT",
    shell: "TEXT",
    tty: "INTEGER",
    login: "INTEGER"
  });
  assertTableColumns(db, "runtime_minecraft_actors", {
    resource_id: "TEXT",
    actor_id: "TEXT",
    transport_kind: "TEXT",
    endpoint: "TEXT",
    protocol_version: "INTEGER",
    persistent_state: "TEXT",
    current_goal: "TEXT",
    model_refs_json: "TEXT",
    allow_autonomy_policy_change: "INTEGER",
    allow_program_deployment: "INTEGER",
    last_event_sequence: "INTEGER"
  });
  assertTableColumns(db, "runtime_minecraft_actor_outbox", {
    resource_id: "TEXT",
    outbox_id: "TEXT",
    event_sequence: "INTEGER",
    kind: "TEXT",
    payload_json: "TEXT",
    status: "TEXT",
    attempt_count: "INTEGER",
    last_error: "TEXT",
    created_at_ms: "INTEGER",
    delivered_at_ms: "INTEGER"
  });
  assertTableColumns(db, "minecraft_actor_control_state", {
    resource_id: "TEXT",
    owner_principal_id: "TEXT",
    revision: "INTEGER",
    loop_phase: "TEXT",
    active_wake_id: "TEXT",
    active_decision_id: "TEXT",
    last_error: "TEXT",
    updated_at_ms: "INTEGER"
  });
  assertTableColumns(db, "minecraft_actor_requests", {
    resource_id: "TEXT",
    request_id: "TEXT",
    idempotency_key: "TEXT",
    fingerprint: "TEXT",
    owner_principal_id: "TEXT",
    owner_session_id: "TEXT",
    instruction: "TEXT",
    constraints_text: "TEXT",
    priority: "TEXT",
    status: "TEXT",
    decision_id: "TEXT",
    result_summary: "TEXT",
    error: "TEXT",
    created_at_ms: "INTEGER",
    updated_at_ms: "INTEGER",
    started_at_ms: "INTEGER",
    completed_at_ms: "INTEGER"
  });
  assertTableColumns(db, "minecraft_actor_wake_mailbox", {
    resource_id: "TEXT",
    wake_id: "TEXT",
    source_type: "TEXT",
    source_id: "TEXT",
    fingerprint: "TEXT",
    priority: "TEXT",
    wake_type: "TEXT",
    summary: "TEXT",
    details_json: "TEXT",
    status: "TEXT",
    decision_id: "TEXT",
    attempt_count: "INTEGER",
    next_attempt_at_ms: "INTEGER",
    last_error: "TEXT",
    created_at_ms: "INTEGER",
    updated_at_ms: "INTEGER",
    completed_at_ms: "INTEGER"
  });
  assertTableColumns(db, "minecraft_actor_decisions", {
    resource_id: "TEXT",
    decision_id: "TEXT",
    wake_id: "TEXT",
    request_id: "TEXT",
    status: "TEXT",
    attempt_count: "INTEGER",
    wake_type: "TEXT",
    wake_summary: "TEXT",
    decision_summary: "TEXT",
    error: "TEXT",
    created_at_ms: "INTEGER",
    updated_at_ms: "INTEGER",
    started_at_ms: "INTEGER",
    completed_at_ms: "INTEGER"
  });
  assertTableColumns(db, "minecraft_actor_events", {
    event_id: "INTEGER",
    resource_id: "TEXT",
    event_type: "TEXT",
    severity: "TEXT",
    actor_revision: "INTEGER",
    request_id: "TEXT",
    decision_id: "TEXT",
    payload_json: "TEXT",
    occurred_at_ms: "INTEGER"
  });
}

function createRecentErrorsSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recent_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at_ms INTEGER NOT NULL CHECK (captured_at_ms >= 0),
      level TEXT NOT NULL CHECK (level IN ('error', 'fatal')),
      event TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      error_name TEXT,
      stack TEXT,
      context_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_recent_errors_time ON recent_errors(captured_at_ms DESC, id DESC);");
}

function validateRecentErrorsSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "recent_errors", {
    id: "INTEGER",
    captured_at_ms: "INTEGER",
    level: "TEXT",
    event: "TEXT",
    message: "TEXT",
    error_name: "TEXT",
    stack: "TEXT",
    context_json: "TEXT"
  });
}

const STATE_TABLE_GROUPS: SqliteTableGroupDefinition[] = [
  {
    groupId: "state.persona",
    schemaVersion: 2,
    minReadableSchemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["persona"],
    createSchema: createPersonaSchema,
    migrateSchema: migratePersonaSchema,
    validateSchema: validatePersonaSchema
  },
  {
    groupId: "state.whitelist",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["whitelist_entries"],
    createSchema: createWhitelistSchema,
    validateSchema: validateWhitelistSchema
  },
  {
    groupId: "state.rp_profile",
    schemaVersion: 2,
    minReadableSchemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["rp_profile"],
    createSchema: createRpProfileSchema,
    migrateSchema: migrateRpProfileSchema,
    validateSchema: validateRpProfileSchema
  },
  {
    groupId: "state.global_profile_readiness",
    schemaVersion: 2,
    minReadableSchemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["global_profile_readiness"],
    createSchema: createGlobalProfileReadinessSchema,
    migrateSchema: migrateGlobalProfileReadinessSchema,
    validateSchema: validateGlobalProfileReadinessSchema
  },
  {
    groupId: "state.setup_state",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["setup_state"],
    createSchema: createSetupStateSchema,
    validateSchema: validateSetupStateSchema
  },
  {
    groupId: "state.users",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["users", "user_memories"],
    createSchema: createUsersSchema,
    validateSchema: validateUsersSchema
  },
  {
    groupId: "state.requests",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["pending_requests"],
    createSchema: createRequestsSchema,
    validateSchema: validateRequestsSchema
  },
  {
    groupId: "state.scheduled_jobs",
    schemaVersion: 2,
    ownedTables: ["scheduled_jobs", "scheduled_job_targets"],
    ownedIndexes: ["idx_scheduled_job_targets_job_order"],
    createSchema: createScheduledJobsSchema,
    validateSchema: validateScheduledJobsSchema
  },
  {
    groupId: "state.rules",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["global_rules", "toolset_rules", "toolset_rule_toolsets"],
    createSchema: createRulesSchema,
    validateSchema: validateRulesSchema
  },
  {
    groupId: "state.user_identities",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["user_identities"],
    createSchema: createUserIdentitiesSchema,
    validateSchema: validateUserIdentitiesSchema
  },
  {
    groupId: "state.group_membership",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["group_membership_entries"],
    createSchema: createGroupMembershipSchema,
    validateSchema: validateGroupMembershipSchema
  },
  {
    groupId: "state.runtime_resources",
    schemaVersion: 4,
    minReadableSchemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: [
      "runtime_resources",
      "runtime_browser_pages",
      "runtime_shell_sessions",
      "runtime_minecraft_actors",
      "runtime_minecraft_actor_outbox",
      "minecraft_actor_control_state",
      "minecraft_actor_requests",
      "minecraft_actor_wake_mailbox",
      "minecraft_actor_decisions",
      "minecraft_actor_events"
    ],
    ownedIndexes: [
      "idx_minecraft_actor_requests_status",
      "idx_minecraft_actor_wake_pending",
      "idx_minecraft_actor_events_cursor"
    ],
    createSchema: createRuntimeResourcesSchema,
    migrateSchema: migrateRuntimeResourcesSchema,
    validateSchema: validateRuntimeResourcesSchema
  },
  {
    groupId: "state.recent_errors",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["recent_errors"],
    ownedIndexes: ["idx_recent_errors_time"],
    createSchema: createRecentErrorsSchema,
    validateSchema: validateRecentErrorsSchema
  }
];
