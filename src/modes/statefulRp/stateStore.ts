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
import { clampAndCompactState } from "./clockAndRules.ts";
import {
  createInitialStatefulRpSessionState,
  statefulRpSessionStateSchema,
  type StatefulRpSessionState
} from "./types.ts";

export class StatefulRpStateStore {
  private readonly dbPath: string;
  private sqlite: SqliteDatabaseHandle | null = null;
  private readonly writes = new Map<string, Promise<unknown>>();

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

  async get(sessionId: string): Promise<StatefulRpSessionState | null> {
    const db = await this.getReadyDb();
    return getStatefulRpStateRow(db, sessionId);
  }

  async listRows(input: { offset?: number; limit?: number; filters?: Record<string, unknown> } = {}): Promise<{
    rows: Array<{ sessionId: string; state: StatefulRpSessionState; updatedAtMs: number }>;
    total: number;
    offset: number;
    limit: number;
  }> {
    const db = await this.getReadyDb();
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
    const sessionId = typeof input.filters?.sessionId === "string" && input.filters.sessionId.trim()
      ? input.filters.sessionId.trim()
      : null;
    const whereSql = sessionId ? "WHERE session_id = ?" : "";
    const params = sessionId ? [sessionId] : [];
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM stateful_rp_session_states ${whereSql}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`
      SELECT session_id, state_json, updated_at_ms
      FROM stateful_rp_session_states
      ${whereSql}
      ORDER BY updated_at_ms DESC, session_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as StatefulRpStateRow[];
    return {
      rows: rows.map((row) => ({
        sessionId: row.session_id,
        state: statefulRpSessionStateSchema.parse(JSON.parse(row.state_json)),
        updatedAtMs: row.updated_at_ms
      })),
      total,
      offset,
      limit
    };
  }

  async ensure(
    sessionId: string,
    defaults?: {
      startClockIso?: string;
    }
  ): Promise<StatefulRpSessionState> {
    return this.enqueueWrite(sessionId, async () => {
      const db = await this.getReadyDb();
      const existing = getStatefulRpStateRow(db, sessionId);
      if (existing) {
        return existing;
      }
      const created = createInitialStatefulRpSessionState({
        sessionId,
        startClockIso: defaults?.startClockIso
      });
      writeStatefulRpStateRow(db, sessionId, created);
      return created;
    }, { allowNullResult: false });
  }

  async write(sessionId: string, state: StatefulRpSessionState): Promise<StatefulRpSessionState> {
    return this.enqueueWrite(sessionId, async () => {
      const db = await this.getReadyDb();
      const parsed = clampAndCompactState(statefulRpSessionStateSchema.parse({
        ...state,
        sessionId
      }));
      writeStatefulRpStateRow(db, sessionId, parsed);
      return parsed;
    }, { allowNullResult: false });
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.enqueueWrite(sessionId, async () => {
      const db = await this.getReadyDb();
      const result = db.prepare(`
        DELETE FROM stateful_rp_session_states
        WHERE session_id = ?
      `).run(sessionId);
      return result.changes > 0;
    }, { allowNullResult: true });
  }

  async update(
    sessionId: string,
    updater: (current: StatefulRpSessionState) => StatefulRpSessionState | Promise<StatefulRpSessionState>,
    defaults?: {
      startClockIso?: string;
    }
  ): Promise<StatefulRpSessionState> {
    return this.enqueueWrite(sessionId, async () => {
      const db = await this.getReadyDb();
      const current = getStatefulRpStateRow(db, sessionId) ?? createInitialStatefulRpSessionState({
        sessionId,
        startClockIso: defaults?.startClockIso
      });
      const updated = await updater(current);
      const next = clampAndCompactState(statefulRpSessionStateSchema.parse({
        ...updated,
        sessionId,
        updatedAt: new Date().toISOString()
      }));
      writeStatefulRpStateRow(db, sessionId, next);
      return next;
    }, { allowNullResult: false });
  }

  async ensureForSession(
    session: Pick<SessionState, "id">,
    defaults?: { startClockIso?: string }
  ): Promise<StatefulRpSessionState> {
    return this.ensure(session.id, defaults);
  }

  private async getReadyDb(): Promise<SqliteDatabase> {
    if (!this.sqlite) {
      this.sqlite = await this.sqliteService.openDatabase({
        databaseId: "sessions",
        dbPath: this.dbPath,
        tableGroups: createStatefulRpTableGroups(),
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

  private async enqueueWrite<T>(
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
      throw new Error(`Stateful RP state write returned null for session ${sessionId}`);
    }
    return result;
  }
}

type StatefulRpStateRow = {
  session_id: string;
  state_json: string;
  updated_at_ms: number;
};

function getStatefulRpStateRow(db: SqliteDatabase, sessionId: string): StatefulRpSessionState | null {
  const row = db.prepare(`
    SELECT session_id, state_json, updated_at_ms
    FROM stateful_rp_session_states
    WHERE session_id = ?
  `).get(sessionId) as StatefulRpStateRow | undefined;
  if (!row) {
    return null;
  }
  try {
    return clampAndCompactState(statefulRpSessionStateSchema.parse(JSON.parse(row.state_json)));
  } catch (error: unknown) {
    throw new Error(
      `stateful_rp_state_store_load_failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function writeStatefulRpStateRow(db: SqliteDatabase, sessionId: string, state: StatefulRpSessionState): void {
  db.prepare(`
    INSERT INTO stateful_rp_session_states (
      session_id,
      state_json,
      updated_at_ms
    ) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at_ms = excluded.updated_at_ms
  `).run(sessionId, JSON.stringify(state), Date.now());
}

function createStatefulRpStateSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stateful_rp_session_states (
      session_id TEXT PRIMARY KEY NOT NULL CHECK (session_id = trim(session_id) AND length(session_id) > 0),
      state_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function validateStatefulRpStateSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "stateful_rp_session_states", {
    session_id: "TEXT",
    state_json: "TEXT",
    updated_at_ms: "INTEGER"
  });
}

function createStatefulRpTableGroups(): SqliteTableGroupDefinition[] {
  return [{
    groupId: "sessions.stateful_rp_state",
    schemaVersion: 1,
    minReadableSchemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["stateful_rp_session_states"],
    createSchema: createStatefulRpStateSchema,
    validateSchema: validateStatefulRpStateSchema
  }];
}
