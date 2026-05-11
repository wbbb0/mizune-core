import { join } from "node:path";
import type { Logger } from "pino";
import {
  assertTableColumns,
  SqliteService,
  type SqliteDatabase,
  type SqliteDatabaseHandle,
  type SqliteTableGroupDefinition
} from "#data/sqlite/sqliteService.ts";

export class AssetsDatabase {
  private readonly dbPath: string;
  private sqlite: SqliteDatabaseHandle | null = null;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly sqliteService = new SqliteService(logger)
  ) {
    this.dbPath = join(dataDir, "assets", "assets.sqlite");
  }

  async init(): Promise<void> {
    if (this.sqlite) {
      return;
    }
    this.sqlite = await this.sqliteService.openDatabase({
      databaseId: "assets",
      dbPath: this.dbPath,
      tableGroups: ASSETS_TABLE_GROUPS,
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
      throw new Error("Assets database is not initialized");
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

function createAudioFilesSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audio_files (
      id TEXT PRIMARY KEY NOT NULL CHECK (id = trim(id) AND length(id) > 0),
      source TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      transcription TEXT,
      transcription_status TEXT NOT NULL CHECK (transcription_status IN ('missing', 'queued', 'ready', 'failed')),
      transcription_updated_at_ms INTEGER,
      transcription_model_ref TEXT,
      transcription_error TEXT
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_audio_files_created_at ON audio_files(created_at_ms DESC, id ASC);");
}

function createChatFilesSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_files (
      file_id TEXT PRIMARY KEY NOT NULL CHECK (file_id = trim(file_id) AND length(file_id) > 0),
      file_ref TEXT NOT NULL,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL,
      chat_file_path TEXT NOT NULL,
      source_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      source_context_json TEXT NOT NULL,
      caption TEXT,
      caption_status TEXT NOT NULL CHECK (caption_status IN ('missing', 'queued', 'ready', 'failed')),
      caption_updated_at_ms INTEGER,
      caption_model_ref TEXT,
      caption_error TEXT
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_files_created_at ON chat_files(created_at_ms DESC, file_id ASC);");
}

function createComfyTasksSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comfy_tasks (
      id TEXT PRIMARY KEY NOT NULL CHECK (id = trim(id) AND length(id) > 0),
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      workflow_file TEXT NOT NULL,
      workflow_snapshot_json TEXT NOT NULL,
      positive_prompt TEXT NOT NULL,
      aspect_ratio TEXT NOT NULL,
      resolved_width INTEGER NOT NULL,
      resolved_height INTEGER NOT NULL,
      comfy_prompt_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'notified')),
      result_file_ids_json TEXT NOT NULL,
      result_files_json TEXT NOT NULL,
      auto_iteration_index INTEGER NOT NULL,
      max_auto_iterations INTEGER NOT NULL,
      last_error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      finished_at_ms INTEGER
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_comfy_tasks_status ON comfy_tasks(status, updated_at_ms DESC, id ASC);");
}

function createContentSafetyAuditsSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_safety_audits (
      key TEXT PRIMARY KEY NOT NULL CHECK (key = trim(key) AND length(key) > 0),
      subject_kind TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('allow', 'review', 'block', 'error')),
      marker TEXT NOT NULL,
      result_json TEXT NOT NULL,
      original_text TEXT,
      file_id TEXT,
      audio_id TEXT,
      content_hash TEXT,
      source_name TEXT,
      session_id TEXT,
      checked_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_content_safety_audits_file ON content_safety_audits(file_id, checked_at_ms DESC, key ASC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_content_safety_audits_audio ON content_safety_audits(audio_id, checked_at_ms DESC, key ASC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_content_safety_audits_session ON content_safety_audits(session_id, checked_at_ms DESC, key ASC);");
}

function validateAudioFilesSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "audio_files", {
    id: "TEXT",
    source: "TEXT",
    created_at_ms: "INTEGER",
    transcription: "TEXT",
    transcription_status: "TEXT",
    transcription_updated_at_ms: "INTEGER",
    transcription_model_ref: "TEXT",
    transcription_error: "TEXT"
  });
}

function validateChatFilesSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "chat_files", {
    file_id: "TEXT",
    file_ref: "TEXT",
    kind: "TEXT",
    origin: "TEXT",
    chat_file_path: "TEXT",
    source_name: "TEXT",
    mime_type: "TEXT",
    size_bytes: "INTEGER",
    created_at_ms: "INTEGER",
    source_context_json: "TEXT",
    caption: "TEXT",
    caption_status: "TEXT",
    caption_updated_at_ms: "INTEGER",
    caption_model_ref: "TEXT",
    caption_error: "TEXT"
  });
}

function validateComfyTasksSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "comfy_tasks", {
    id: "TEXT",
    session_id: "TEXT",
    user_id: "TEXT",
    template_id: "TEXT",
    workflow_file: "TEXT",
    workflow_snapshot_json: "TEXT",
    positive_prompt: "TEXT",
    aspect_ratio: "TEXT",
    resolved_width: "INTEGER",
    resolved_height: "INTEGER",
    comfy_prompt_id: "TEXT",
    status: "TEXT",
    result_file_ids_json: "TEXT",
    result_files_json: "TEXT",
    auto_iteration_index: "INTEGER",
    max_auto_iterations: "INTEGER",
    last_error: "TEXT",
    created_at_ms: "INTEGER",
    updated_at_ms: "INTEGER",
    started_at_ms: "INTEGER",
    finished_at_ms: "INTEGER"
  });
}

function validateContentSafetyAuditsSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "content_safety_audits", {
    key: "TEXT",
    subject_kind: "TEXT",
    decision: "TEXT",
    marker: "TEXT",
    result_json: "TEXT",
    original_text: "TEXT",
    file_id: "TEXT",
    audio_id: "TEXT",
    content_hash: "TEXT",
    source_name: "TEXT",
    session_id: "TEXT",
    checked_at_ms: "INTEGER",
    expires_at_ms: "INTEGER"
  });
}

const ASSETS_TABLE_GROUPS: SqliteTableGroupDefinition[] = [
  {
    groupId: "assets.audio_files",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["audio_files"],
    ownedIndexes: ["idx_audio_files_created_at"],
    createSchema: createAudioFilesSchema,
    validateSchema: validateAudioFilesSchema
  },
  {
    groupId: "assets.chat_files",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["chat_files"],
    ownedIndexes: ["idx_chat_files_created_at"],
    createSchema: createChatFilesSchema,
    validateSchema: validateChatFilesSchema
  },
  {
    groupId: "assets.comfy_tasks",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["comfy_tasks"],
    ownedIndexes: ["idx_comfy_tasks_status"],
    createSchema: createComfyTasksSchema,
    validateSchema: validateComfyTasksSchema
  },
  {
    groupId: "assets.content_safety_audits",
    schemaVersion: 1,
    resetPolicy: "block_reset",
    ownedTables: ["content_safety_audits"],
    ownedIndexes: [
      "idx_content_safety_audits_file",
      "idx_content_safety_audits_audio",
      "idx_content_safety_audits_session"
    ],
    createSchema: createContentSafetyAuditsSchema,
    validateSchema: validateContentSafetyAuditsSchema
  }
];