import { existsSync } from "node:fs";
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
  migrateScenarioHostSessionState,
  scenarioHostSessionStateSchema,
  type ScenarioHostSessionState
} from "./types.ts";
import { scenarioProfileSchema, type ScenarioProfile } from "./profileSchema.ts";

export class ScenarioHostStateStore {
  private readonly dbPath: string;
  private readonly legacyStateDbPath: string;
  private sqlite: SqliteDatabaseHandle | null = null;
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(
    dataDir: string,
    private readonly _config: Pick<AppConfig, "backup">,
    private readonly logger: Logger,
    private readonly sqliteService = new SqliteService(logger)
  ) {
    this.dbPath = join(dataDir, "sessions", "sessions.sqlite");
    this.legacyStateDbPath = join(dataDir, "state", "state.sqlite");
  }

  async init(): Promise<void> {
    await this.getReadyDb();
  }

  async get(sessionId: string): Promise<ScenarioHostSessionState | null> {
    const db = await this.getReadyDb();
    return getScenarioHostStateRow(db, sessionId);
  }

  async listRows(input: { offset?: number; limit?: number; filters?: Record<string, unknown> } = {}): Promise<{
    rows: Array<{ sessionId: string; state: ScenarioHostSessionState; updatedAtMs: number }>;
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
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM scenario_host_session_states ${whereSql}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`
      SELECT session_id, state_json, updated_at_ms
      FROM scenario_host_session_states
      ${whereSql}
      ORDER BY updated_at_ms DESC, session_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as ScenarioHostStateRow[];
    return {
      rows: rows.map((row) => ({
        sessionId: row.session_id,
        state: migrateScenarioHostSessionState(JSON.parse(row.state_json)),
        updatedAtMs: row.updated_at_ms
      })),
      total,
      offset,
      limit
    };
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

  async delete(sessionId: string): Promise<boolean> {
    return this.enqueueWrite(sessionId, async () => {
      const db = await this.getReadyDb();
      const result = db.prepare(`
        DELETE FROM scenario_host_session_states
        WHERE session_id = ?
      `).run(sessionId);
      return result.changes > 0;
    }, { allowNullResult: true });
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
        tableGroups: createScenarioHostTableGroups(this.legacyStateDbPath),
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
      throw new Error(`Scenario host state write returned null for session ${sessionId}`);
    }
    return result;
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
    return migrateScenarioHostSessionState(JSON.parse(row.state_json));
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

function migrateScenarioHostStateSchema(db: SqliteDatabase, legacyStateDbPath: string): boolean {
  const rows = db.prepare(`
    SELECT session_id, state_json
    FROM scenario_host_session_states
  `).all() as Array<{ session_id: string; state_json: string }>;
  const update = db.prepare(`
    UPDATE scenario_host_session_states
    SET state_json = ?, updated_at_ms = ?
    WHERE session_id = ?
  `);
  const now = Date.now();
  const legacyProfile = readLegacyScenarioProfile(db, legacyStateDbPath);
  for (const row of rows) {
    const migrated = migrateScenarioHostSessionState(JSON.parse(row.state_json));
    const nextState = legacyProfile && !isProfileCompleteEnough(migrated.profile)
      ? { ...migrated, profile: legacyProfile }
      : migrated;
    update.run(JSON.stringify(nextState), now, row.session_id);
  }
  return true;
}

function readLegacyScenarioProfile(db: SqliteDatabase, legacyStateDbPath: string): ScenarioProfile | null {
  if (!existsSync(legacyStateDbPath)) {
    return null;
  }
  const schemaName = "legacy_scenario_profile_state";
  let attached = false;
  try {
    db.prepare(`ATTACH DATABASE ? AS ${schemaName}`).run(legacyStateDbPath);
    attached = true;
    const table = db.prepare(`
      SELECT name
      FROM ${schemaName}.sqlite_master
      WHERE type = 'table'
        AND name = 'scenario_profile'
    `).get() as { name: string } | undefined;
    if (!table) {
      return null;
    }
    const columns = new Set((db.prepare(`PRAGMA ${schemaName}.table_info(scenario_profile)`).all() as Array<{ name: string }>)
      .map((column) => column.name));
    if (columns.has("narration_style")) {
      const row = db.prepare(`
        SELECT
          theme,
          world_baseline AS worldBaseline,
          narration_style AS narrationStyle,
          boundaries
        FROM ${schemaName}.scenario_profile
        WHERE id = 'global'
      `).get() as ScenarioProfile | undefined;
      return row ? scenarioProfileSchema.parse(row) : null;
    }
    if (columns.has("host_style")) {
      const row = db.prepare(`
        SELECT
          theme,
          host_style AS hostStyle,
          world_baseline AS worldBaseline,
          safety_or_taboo_rules AS safetyOrTabooRules,
          opening_pattern AS openingPattern
        FROM ${schemaName}.scenario_profile
        WHERE id = 'global'
      `).get() as {
        theme?: string;
        hostStyle?: string;
        worldBaseline?: string;
        safetyOrTabooRules?: string;
        openingPattern?: string;
      } | undefined;
      return row
        ? scenarioProfileSchema.parse({
            theme: row.theme ?? "",
            worldBaseline: row.worldBaseline ?? "",
            narrationStyle: joinNonEmpty([row.hostStyle, row.openingPattern]),
            boundaries: row.safetyOrTabooRules ?? ""
          })
        : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (attached) {
      try {
        db.exec(`DETACH DATABASE ${schemaName}`);
      } catch {
        // Best-effort cleanup for a one-time legacy read.
      }
    }
  }
}

function isProfileCompleteEnough(profile: ScenarioProfile): boolean {
  return Boolean(profile.theme.trim() || profile.worldBaseline.trim() || profile.narrationStyle.trim() || profile.boundaries.trim());
}

function joinNonEmpty(values: Array<string | undefined>): string {
  return values
    .map((value) => value?.trim() ?? "")
    .filter(Boolean)
    .join("；");
}

function createScenarioHostTableGroups(legacyStateDbPath: string): SqliteTableGroupDefinition[] {
  return [{
    groupId: "sessions.scenario_host_state",
    schemaVersion: 4,
    minReadableSchemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["scenario_host_session_states"],
    createSchema: createScenarioHostStateSchema,
    migrateSchema: (db) => migrateScenarioHostStateSchema(db, legacyStateDbPath),
    validateSchema: validateScenarioHostStateSchema
  }];
}
