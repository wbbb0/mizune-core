import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { SessionState } from "#conversation/session/sessionTypes.ts";
import {
  assertTableColumns,
  SqliteService,
  type SqliteDatabase,
  type SqliteDatabaseHandle,
  type SqliteTableGroupDefinition
} from "#data/sqlite/sqliteService.ts";
import { resolveSessionParticipantLabel, resolveSessionParticipantRef } from "#conversation/session/sessionIdentity.ts";
import {
  createInitialScenarioHostSessionState,
  scenarioHostSessionStateSchema,
  type ScenarioHostSessionState
} from "./types.ts";

export class ScenarioHostStateStore {
  private readonly dbPath: string;
  private sqlite: SqliteDatabaseHandle | null = null;
  private readonly writes = new Map<string, Promise<ScenarioHostSessionState | null>>();

  constructor(
    dataDir: string,
    private readonly _config: Pick<AppConfig, "backup">,
    private readonly logger: Logger,
    private readonly sqliteService = new SqliteService(logger)
  ) {
    this.dbPath = join(dataDir, "sessions", "sessions.sqlite");
  }

  async init(): Promise<void> {
    await this.getReadyDb();
  }

  async get(sessionId: string): Promise<ScenarioHostSessionState | null> {
    const db = await this.getReadyDb();
    return getScenarioHostStateRow(db, sessionId);
  }

  async ensure(
    sessionId: string,
    defaults: {
      playerUserId: string;
      playerDisplayName: string;
    }
  ): Promise<ScenarioHostSessionState> {
    return this.enqueueWrite(sessionId, async () => {
      const db = await this.getReadyDb();
      const existing = getScenarioHostStateRow(db, sessionId);
      if (existing) {
        return existing;
      }
      const created = createInitialScenarioHostSessionState(defaults);
      writeScenarioHostStateRow(db, sessionId, created);
      return created;
    }, { allowNullResult: false });
  }

  async write(sessionId: string, state: ScenarioHostSessionState): Promise<ScenarioHostSessionState> {
    return this.enqueueWrite(sessionId, async () => {
      const db = await this.getReadyDb();
      const parsed = scenarioHostSessionStateSchema.parse(state);
      writeScenarioHostStateRow(db, sessionId, parsed);
      return parsed;
    }, { allowNullResult: false });
  }

  async update(
    sessionId: string,
    updater: (current: ScenarioHostSessionState) => ScenarioHostSessionState | Promise<ScenarioHostSessionState>,
    defaults: {
      playerUserId: string;
      playerDisplayName: string;
    }
  ): Promise<ScenarioHostSessionState> {
    return this.enqueueWrite(sessionId, async () => {
      const db = await this.getReadyDb();
      const current = getScenarioHostStateRow(db, sessionId) ?? createInitialScenarioHostSessionState(defaults);
      const next = scenarioHostSessionStateSchema.parse(await updater(current));
      writeScenarioHostStateRow(db, sessionId, next);
      return next;
    }, { allowNullResult: false });
  }

  async ensureForSession(session: Pick<SessionState, "id" | "participantRef">): Promise<ScenarioHostSessionState> {
    const participantRef = resolveSessionParticipantRef({
      sessionId: session.id,
      type: "private",
      participantRef: session.participantRef
    });
    return this.ensure(session.id, {
      playerUserId: participantRef.id,
      playerDisplayName: resolveSessionParticipantLabel({
        sessionId: session.id,
        participantRef,
        title: null
      })
    });
  }

  private async getReadyDb(): Promise<SqliteDatabase> {
    if (!this.sqlite) {
      this.sqlite = await this.sqliteService.openDatabase({
        databaseId: "sessions",
        dbPath: this.dbPath,
        tableGroups: SCENARIO_HOST_TABLE_GROUPS,
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
    return this.sqlite.db;
  }

  private async enqueueWrite<T extends ScenarioHostSessionState | null>(
    sessionId: string,
    operation: () => Promise<T>,
    options: { allowNullResult: boolean }
  ): Promise<T> {
    const previous = this.writes.get(sessionId) ?? Promise.resolve(null);
    const next = previous
      .catch(() => null)
      .then(operation)
      .finally(() => {
        if (this.writes.get(sessionId) === next) {
          this.writes.delete(sessionId);
        }
      });
    this.writes.set(sessionId, next);
    const result = await next;
    if (!options.allowNullResult && result == null) {
      throw new Error(`Scenario host state write returned null for session ${sessionId}`);
    }
    return result as T;
  }
}

type ScenarioHostStateRow = {
  session_id: string;
  state_json: string;
  updated_at_ms: number;
};

function getScenarioHostStateRow(db: SqliteDatabase, sessionId: string): ScenarioHostSessionState | null {
  const row = db.prepare(`
    SELECT session_id, state_json, updated_at_ms
    FROM scenario_host_session_states
    WHERE session_id = ?
  `).get(sessionId) as ScenarioHostStateRow | undefined;
  if (!row) {
    return null;
  }
  try {
    return scenarioHostSessionStateSchema.parse(JSON.parse(row.state_json));
  } catch (error: unknown) {
    throw new Error(
      `scenario_host_state_store_load_failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function writeScenarioHostStateRow(db: SqliteDatabase, sessionId: string, state: ScenarioHostSessionState): void {
  db.prepare(`
    INSERT INTO scenario_host_session_states (
      session_id,
      state_json,
      updated_at_ms
    ) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at_ms = excluded.updated_at_ms
  `).run(sessionId, JSON.stringify(state), Date.now());
}

function createScenarioHostStateSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scenario_host_session_states (
      session_id TEXT PRIMARY KEY NOT NULL CHECK (session_id = trim(session_id) AND length(session_id) > 0),
      state_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function validateScenarioHostStateSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "scenario_host_session_states", {
    session_id: "TEXT",
    state_json: "TEXT",
    updated_at_ms: "INTEGER"
  });
}

const SCENARIO_HOST_TABLE_GROUPS: SqliteTableGroupDefinition[] = [
  {
    groupId: "sessions.scenario_host_state",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["scenario_host_session_states"],
    createSchema: createScenarioHostStateSchema,
    validateSchema: validateScenarioHostStateSchema
  }
];
