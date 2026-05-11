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
      speaking_style TEXT NOT NULL DEFAULT '',
      global_traits TEXT NOT NULL DEFAULT '',
      general_preferences TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function validatePersonaSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "persona", {
    id: "TEXT",
    name: "TEXT",
    temperament: "TEXT",
    speaking_style: "TEXT",
    global_traits: "TEXT",
    general_preferences: "TEXT",
    updated_at_ms: "INTEGER"
  });
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
      self_positioning TEXT NOT NULL DEFAULT '',
      social_role TEXT NOT NULL DEFAULT '',
      life_context TEXT NOT NULL DEFAULT '',
      physical_presence TEXT NOT NULL DEFAULT '',
      bond_to_user TEXT NOT NULL DEFAULT '',
      closeness_pattern TEXT NOT NULL DEFAULT '',
      interaction_pattern TEXT NOT NULL DEFAULT '',
      reality_contract TEXT NOT NULL DEFAULT '',
      continuity_facts TEXT NOT NULL DEFAULT '',
      hard_limits TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function validateRpProfileSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "rp_profile", {
    id: "TEXT",
    self_positioning: "TEXT",
    social_role: "TEXT",
    life_context: "TEXT",
    physical_presence: "TEXT",
    bond_to_user: "TEXT",
    closeness_pattern: "TEXT",
    interaction_pattern: "TEXT",
    reality_contract: "TEXT",
    continuity_facts: "TEXT",
    hard_limits: "TEXT",
    updated_at_ms: "INTEGER"
  });
}

function createScenarioProfileSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scenario_profile (
      id TEXT PRIMARY KEY CHECK (id = 'global'),
      theme TEXT NOT NULL DEFAULT '',
      host_style TEXT NOT NULL DEFAULT '',
      world_baseline TEXT NOT NULL DEFAULT '',
      safety_or_taboo_rules TEXT NOT NULL DEFAULT '',
      opening_pattern TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function validateScenarioProfileSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "scenario_profile", {
    id: "TEXT",
    theme: "TEXT",
    host_style: "TEXT",
    world_baseline: "TEXT",
    safety_or_taboo_rules: "TEXT",
    opening_pattern: "TEXT",
    updated_at_ms: "INTEGER"
  });
}

function createGlobalProfileReadinessSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_profile_readiness (
      id TEXT PRIMARY KEY CHECK (id = 'global'),
      persona TEXT NOT NULL CHECK (persona IN ('uninitialized', 'ready')),
      rp TEXT NOT NULL CHECK (rp IN ('uninitialized', 'ready')),
      scenario TEXT NOT NULL CHECK (scenario IN ('uninitialized', 'ready')),
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function validateGlobalProfileReadinessSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "global_profile_readiness", {
    id: "TEXT",
    persona: "TEXT",
    rp: "TEXT",
    scenario: "TEXT",
    updated_at_ms: "INTEGER"
  });
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
      schedule_json TEXT NOT NULL CHECK (json_valid(schedule_json)),
      instruction TEXT NOT NULL CHECK (instruction = trim(instruction) AND length(instruction) > 0),
      targets_json TEXT NOT NULL CHECK (json_valid(targets_json)),
      state_json TEXT NOT NULL CHECK (json_valid(state_json)),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0)
    );
  `);
}

function validateScheduledJobsSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "scheduled_jobs", {
    id: "TEXT",
    name: "TEXT",
    enabled: "INTEGER",
    created_at_ms: "INTEGER",
    updated_at_ms: "INTEGER",
    schedule_json: "TEXT",
    instruction: "TEXT",
    targets_json: "TEXT",
    state_json: "TEXT",
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
      kind TEXT NOT NULL CHECK (kind IN ('browser_page', 'shell_session')),
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
  `);
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
}

const STATE_TABLE_GROUPS: SqliteTableGroupDefinition[] = [
  {
    groupId: "state.persona",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["persona"],
    createSchema: createPersonaSchema,
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
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["rp_profile"],
    createSchema: createRpProfileSchema,
    validateSchema: validateRpProfileSchema
  },
  {
    groupId: "state.scenario_profile",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["scenario_profile"],
    createSchema: createScenarioProfileSchema,
    validateSchema: validateScenarioProfileSchema
  },
  {
    groupId: "state.global_profile_readiness",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["global_profile_readiness"],
    createSchema: createGlobalProfileReadinessSchema,
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
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["scheduled_jobs"],
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
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["runtime_resources", "runtime_browser_pages", "runtime_shell_sessions"],
    createSchema: createRuntimeResourcesSchema,
    validateSchema: validateRuntimeResourcesSchema
  }
];
