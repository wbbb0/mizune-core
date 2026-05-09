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
      created_at_ms INTEGER NOT NULL,
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
  }
];
