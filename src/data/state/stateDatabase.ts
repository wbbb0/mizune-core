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
  }
];
