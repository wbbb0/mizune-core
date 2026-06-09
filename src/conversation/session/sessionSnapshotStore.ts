import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  assertIndexExists,
  assertTableColumns,
  SqliteService,
  type SqliteDatabase,
  type SqliteDatabaseHandle,
  type SqliteTableGroupDefinition
} from "#data/sqlite/sqliteService.ts";
import { getDefaultSessionModeId } from "#modes/registry.ts";
import {
  scenarioHostSessionStateSchema,
  type ScenarioHostSessionState
} from "#modes/scenarioHost/types.ts";
import type { PersistedSessionState } from "./sessionTypes.ts";
import { persistedSessionStateSchema } from "./sessionPersistence.ts";

const scenarioHostSessionStateZodSchema = z.unknown().transform((value, context) => {
  try {
    return scenarioHostSessionStateSchema.parse(value);
  } catch (error: unknown) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error)
    });
    return z.NEVER;
  }
});

const sessionSnapshotModeStateSchema = z.union([
  z.object({
    kind: z.literal("scenario_host"),
    state: scenarioHostSessionStateZodSchema
  })
]).nullable();

const sessionSnapshotPayloadSchema = z.object({
  version: z.literal(1),
  session: persistedSessionStateSchema,
  modeState: sessionSnapshotModeStateSchema
});

export type SessionSnapshotModeState =
  | { kind: "scenario_host"; state: ScenarioHostSessionState }
  | null;

export interface SessionSnapshotPayload {
  version: 1;
  session: PersistedSessionState;
  modeState: SessionSnapshotModeState;
}

export interface SessionSnapshotSummary {
  id: string;
  sessionId: string;
  label: string;
  createdAtMs: number;
  modeId: string;
  title: string | null;
  transcriptCount: number;
  hasScenarioHostState: boolean;
}

export interface SessionSnapshotRecord {
  summary: SessionSnapshotSummary;
  payload: SessionSnapshotPayload;
}

export class SessionSnapshotStore {
  private readonly dbPath: string;
  private sqlite: SqliteDatabaseHandle | null = null;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly sqliteService = new SqliteService(logger)
  ) {
    this.dbPath = join(dataDir, "sessions", "sessions.sqlite");
  }

  async init(): Promise<void> {
    await this.getReadyDb();
  }

  async list(sessionId: string): Promise<SessionSnapshotSummary[]> {
    const db = await this.getReadyDb();
    const rows = db.prepare(`
      SELECT snapshot_id, session_id, label, created_at_ms, payload_json
      FROM session_snapshots
      WHERE session_id = ?
      ORDER BY created_at_ms DESC, snapshot_id DESC
    `).all(sessionId) as SessionSnapshotRow[];
    const snapshots: SessionSnapshotSummary[] = [];
    for (const row of rows) {
      try {
        snapshots.push(rowToSnapshotRecord(row).summary);
      } catch (error: unknown) {
        this.logger.warn({ error, sessionId, snapshotId: row.snapshot_id }, "session_snapshot_list_parse_failed");
      }
    }
    return snapshots;
  }

  async create(input: {
    sessionId: string;
    label?: string;
    session: PersistedSessionState;
    modeState: SessionSnapshotModeState;
  }): Promise<SessionSnapshotSummary> {
    const payload = sessionSnapshotPayloadSchema.parse({
      version: 1,
      session: input.session,
      modeState: input.modeState
    }) as SessionSnapshotPayload;
    if (payload.session.id !== input.sessionId) {
      throw new Error(`Snapshot session id mismatch: expected ${input.sessionId}, got ${payload.session.id}`);
    }
    assertSnapshotPayloadConsistent(payload);

    const createdAtMs = Date.now();
    const row: SessionSnapshotRow = {
      snapshot_id: randomUUID(),
      session_id: input.sessionId,
      label: normalizeSnapshotLabel(input.label, createdAtMs),
      created_at_ms: createdAtMs,
      payload_json: JSON.stringify(payload)
    };
    const db = await this.getReadyDb();
    db.prepare(`
      INSERT INTO session_snapshots (
        snapshot_id,
        session_id,
        label,
        created_at_ms,
        payload_json
      ) VALUES (
        @snapshot_id,
        @session_id,
        @label,
        @created_at_ms,
        @payload_json
      )
    `).run(row);
    return rowToSnapshotRecord(row).summary;
  }

  async get(sessionId: string, snapshotId: string): Promise<SessionSnapshotRecord | null> {
    const db = await this.getReadyDb();
    const row = db.prepare(`
      SELECT snapshot_id, session_id, label, created_at_ms, payload_json
      FROM session_snapshots
      WHERE session_id = ?
        AND snapshot_id = ?
    `).get(sessionId, snapshotId) as SessionSnapshotRow | undefined;
    return row ? rowToSnapshotRecord(row) : null;
  }

  async delete(sessionId: string, snapshotId: string): Promise<boolean> {
    const db = await this.getReadyDb();
    const result = db.prepare(`
      DELETE FROM session_snapshots
      WHERE session_id = ?
        AND snapshot_id = ?
    `).run(sessionId, snapshotId);
    return result.changes > 0;
  }

  async deleteAllForSession(sessionId: string): Promise<number> {
    const db = await this.getReadyDb();
    const result = db.prepare(`
      DELETE FROM session_snapshots
      WHERE session_id = ?
    `).run(sessionId);
    return result.changes;
  }

  private async getReadyDb(): Promise<SqliteDatabase> {
    if (!this.sqlite) {
      this.sqlite = await this.sqliteService.openDatabase({
        databaseId: "sessions",
        dbPath: this.dbPath,
        tableGroups: SESSION_SNAPSHOT_TABLE_GROUPS,
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
}

interface SessionSnapshotRow {
  snapshot_id: string;
  session_id: string;
  label: string;
  created_at_ms: number;
  payload_json: string;
}

function rowToSnapshotRecord(row: SessionSnapshotRow): SessionSnapshotRecord {
  const payload = sessionSnapshotPayloadSchema.parse(JSON.parse(row.payload_json)) as SessionSnapshotPayload;
  if (payload.session.id !== row.session_id) {
    throw new Error(`Session snapshot payload id mismatch: expected ${row.session_id}, got ${payload.session.id}`);
  }
  assertSnapshotPayloadConsistent(payload);
  return {
    summary: {
      id: row.snapshot_id,
      sessionId: row.session_id,
      label: row.label,
      createdAtMs: row.created_at_ms,
      modeId: payload.session.modeId ?? getDefaultSessionModeId(),
      title: payload.session.title,
      transcriptCount: payload.session.internalTranscript.length,
      hasScenarioHostState: payload.modeState?.kind === "scenario_host"
    },
    payload
  };
}

function assertSnapshotPayloadConsistent(payload: SessionSnapshotPayload): void {
  if (payload.modeState?.kind === "scenario_host" && payload.session.modeId !== "scenario_host") {
    throw new Error("Scenario host snapshot payload must belong to a scenario_host session");
  }
}

function normalizeSnapshotLabel(label: string | undefined, createdAtMs: number): string {
  const trimmed = String(label ?? "").trim();
  return trimmed || `存档 ${new Date(createdAtMs).toISOString()}`;
}

function createSessionSnapshotSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_snapshots (
      snapshot_id TEXT PRIMARY KEY NOT NULL CHECK (snapshot_id = trim(snapshot_id) AND length(snapshot_id) > 0),
      session_id TEXT NOT NULL CHECK (session_id = trim(session_id) AND length(session_id) > 0),
      label TEXT NOT NULL CHECK (label = trim(label) AND length(label) > 0),
      created_at_ms INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_snapshots_session_created_at
      ON session_snapshots(session_id, created_at_ms DESC);
  `);
}

function validateSessionSnapshotSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "session_snapshots", {
    snapshot_id: "TEXT",
    session_id: "TEXT",
    label: "TEXT",
    created_at_ms: "INTEGER",
    payload_json: "TEXT"
  });
  assertIndexExists(db, "idx_session_snapshots_session_created_at");
}

const SESSION_SNAPSHOT_TABLE_GROUPS: SqliteTableGroupDefinition[] = [{
  groupId: "sessions.snapshots",
  schemaVersion: 1,
  minReadableSchemaVersion: 1,
  resetPolicy: "block_reset",
  ownedTables: ["session_snapshots"],
  ownedIndexes: ["idx_session_snapshots_session_created_at"],
  createSchema: createSessionSnapshotSchema,
  validateSchema: validateSessionSnapshotSchema
}];
