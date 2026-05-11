import type { SqliteDatabase } from "#data/sqlite/sqliteService.ts";
import { AssetsDatabase } from "#data/assets/assetsDatabase.ts";
import { z } from "zod";
import type { Logger } from "pino";
import type { ContentSafetyAuditRecord, ContentSafetyAuditView, ModerationDecision, ModerationSubjectKind } from "./contentSafetyTypes.ts";

const moderationLabelSchema = z.object({
  label: z.string().min(1),
  category: z.string().min(1).optional(),
  riskLevel: z.enum(["none", "low", "medium", "high"]).optional(),
  confidence: z.number().optional(),
  providerReason: z.string().min(1).optional()
});

const moderationResultSchema = z.object({
  decision: z.enum(["allow", "review", "block", "error"]),
  reason: z.string(),
  labels: z.array(moderationLabelSchema),
  providerId: z.string().min(1),
  providerType: z.string().min(1),
  requestId: z.string().min(1).optional(),
  rawDecision: z.string().min(1).optional(),
  checkedAtMs: z.number().int().nonnegative()
});

const auditRecordSchema = z.object({
  key: z.string().min(1),
  subjectKind: z.enum(["text", "image", "emoji", "audio", "audio_transcript", "file", "local_media"]),
  decision: z.enum(["allow", "review", "block", "error"]),
  marker: z.string(),
  result: moderationResultSchema,
  originalText: z.string().optional(),
  fileId: z.string().min(1).optional(),
  audioId: z.string().min(1).optional(),
  contentHash: z.string().min(1).optional(),
  sourceName: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  checkedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative().optional()
});

const contentSafetyFileSchema = z.object({
  version: z.literal(1),
  records: z.array(auditRecordSchema)
});

type ContentSafetyFile = z.infer<typeof contentSafetyFileSchema>;

export class ContentSafetyStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly assetsDatabase = new AssetsDatabase(dataDir, logger)
  ) {}

  async init(): Promise<void> {
    await this.assetsDatabase.init();
  }

  async upsert(record: ContentSafetyAuditRecord): Promise<void> {
    await this.withWriteLock(async () => {
      const db = await this.getReadyDb();
      db.prepare(`
        INSERT INTO content_safety_audits (
          key,
          subject_kind,
          decision,
          marker,
          result_json,
          original_text,
          file_id,
          audio_id,
          content_hash,
          source_name,
          session_id,
          checked_at_ms,
          expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          subject_kind = excluded.subject_kind,
          decision = excluded.decision,
          marker = excluded.marker,
          result_json = excluded.result_json,
          original_text = excluded.original_text,
          file_id = excluded.file_id,
          audio_id = excluded.audio_id,
          content_hash = excluded.content_hash,
          source_name = excluded.source_name,
          session_id = excluded.session_id,
          checked_at_ms = excluded.checked_at_ms,
          expires_at_ms = excluded.expires_at_ms
      `).run(...recordToParams(record));
    });
  }

  async getByKey(key: string): Promise<ContentSafetyAuditRecord | null> {
    const db = await this.getReadyDb();
    const row = db.prepare(`
      SELECT
        key,
        subject_kind AS subjectKind,
        decision,
        marker,
        result_json AS resultJson,
        original_text AS originalText,
        file_id AS fileId,
        audio_id AS audioId,
        content_hash AS contentHash,
        source_name AS sourceName,
        session_id AS sessionId,
        checked_at_ms AS checkedAtMs,
        expires_at_ms AS expiresAtMs
      FROM content_safety_audits
      WHERE key = ?
    `).get(key) as ContentSafetyAuditRow | undefined;
    return row ? rowToAuditRecord(row) : null;
  }

  async getByFileId(fileId: string): Promise<ContentSafetyAuditRecord | null> {
    const db = await this.getReadyDb();
    const row = db.prepare(`
      SELECT
        key,
        subject_kind AS subjectKind,
        decision,
        marker,
        result_json AS resultJson,
        original_text AS originalText,
        file_id AS fileId,
        audio_id AS audioId,
        content_hash AS contentHash,
        source_name AS sourceName,
        session_id AS sessionId,
        checked_at_ms AS checkedAtMs,
        expires_at_ms AS expiresAtMs
      FROM content_safety_audits
      WHERE file_id = ?
      ORDER BY checked_at_ms DESC, key ASC
      LIMIT 1
    `).get(fileId) as ContentSafetyAuditRow | undefined;
    return row ? rowToAuditRecord(row) : null;
  }

  async getByAudioId(audioId: string): Promise<ContentSafetyAuditRecord | null> {
    const db = await this.getReadyDb();
    const row = db.prepare(`
      SELECT
        key,
        subject_kind AS subjectKind,
        decision,
        marker,
        result_json AS resultJson,
        original_text AS originalText,
        file_id AS fileId,
        audio_id AS audioId,
        content_hash AS contentHash,
        source_name AS sourceName,
        session_id AS sessionId,
        checked_at_ms AS checkedAtMs,
        expires_at_ms AS expiresAtMs
      FROM content_safety_audits
      WHERE audio_id = ?
      ORDER BY checked_at_ms DESC, key ASC
      LIMIT 1
    `).get(audioId) as ContentSafetyAuditRow | undefined;
    return row ? rowToAuditRecord(row) : null;
  }

  async listBySessionId(sessionId: string): Promise<ContentSafetyAuditView[]> {
    const db = await this.getReadyDb();
    const rows = db.prepare(`
      SELECT
        key,
        subject_kind AS subjectKind,
        decision,
        marker,
        result_json AS resultJson,
        original_text AS originalText,
        file_id AS fileId,
        audio_id AS audioId,
        content_hash AS contentHash,
        source_name AS sourceName,
        session_id AS sessionId,
        checked_at_ms AS checkedAtMs,
        expires_at_ms AS expiresAtMs
      FROM content_safety_audits
      WHERE session_id = ?
        AND decision IN ('block', 'review')
      ORDER BY checked_at_ms DESC, key ASC
    `).all(sessionId) as ContentSafetyAuditRow[];
    return rows.map(rowToAuditRecord).map(toAuditView);
  }

  async getViewByFileId(fileId: string): Promise<ContentSafetyAuditView | null> {
    const record = await this.getByFileId(fileId);
    return record ? toAuditView(record) : null;
  }

  async isBlockedFileId(fileId: string): Promise<{ blocked: true; marker: string; reason: string } | null> {
    const record = await this.getByFileId(fileId);
    if (!record || !isBlockingDecision(record.decision)) {
      return null;
    }
    return {
      blocked: true,
      marker: record.marker,
      reason: record.result.reason
    };
  }

  private async withWriteLock<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      release();
    }
  }

  private async getReadyDb(): Promise<SqliteDatabase> {
    await this.assetsDatabase.init();
    return this.assetsDatabase.getDb();
  }
}

type ContentSafetyAuditRow = {
  key: string;
  subjectKind: ModerationSubjectKind;
  decision: ModerationDecision;
  marker: string;
  resultJson: string;
  originalText: string | null;
  fileId: string | null;
  audioId: string | null;
  contentHash: string | null;
  sourceName: string | null;
  sessionId: string | null;
  checkedAtMs: number;
  expiresAtMs: number | null;
};

function rowToAuditRecord(row: ContentSafetyAuditRow): ContentSafetyAuditRecord {
  const parsed = parseStoredAuditResult(row.resultJson);
  return {
    key: row.key,
    subjectKind: row.subjectKind,
    decision: row.decision,
    marker: row.marker,
    result: parsed,
    ...(row.originalText !== null ? { originalText: row.originalText } : {}),
    ...(row.fileId !== null ? { fileId: row.fileId } : {}),
    ...(row.audioId !== null ? { audioId: row.audioId } : {}),
    ...(row.contentHash !== null ? { contentHash: row.contentHash } : {}),
    ...(row.sourceName !== null ? { sourceName: row.sourceName } : {}),
    ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
    checkedAtMs: row.checkedAtMs,
    ...(row.expiresAtMs !== null ? { expiresAtMs: row.expiresAtMs } : {})
  };
}

function recordToParams(record: ContentSafetyAuditRecord): [
  string,
  ModerationSubjectKind,
  ModerationDecision,
  string,
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  number,
  number | null
] {
  return [
    record.key,
    record.subjectKind,
    record.decision,
    record.marker,
    JSON.stringify(record.result),
    record.originalText ?? null,
    record.fileId ?? null,
    record.audioId ?? null,
    record.contentHash ?? null,
    record.sourceName ?? null,
    record.sessionId ?? null,
    record.checkedAtMs,
    record.expiresAtMs ?? null
  ];
}

function parseStoredAuditResult(value: string) {
  try {
    return moderationResultSchema.parse(JSON.parse(value));
  } catch (error: unknown) {
    throw new Error(`Invalid content safety audit row: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isBlockingDecision(decision: ModerationDecision): boolean {
  return decision === "block" || decision === "review";
}

function toAuditView(record: ContentSafetyAuditRecord): ContentSafetyAuditView {
  return {
    key: record.key,
    subjectKind: record.subjectKind,
    decision: record.decision,
    marker: record.marker,
    reason: record.result.reason,
    labels: record.result.labels,
    providerId: record.result.providerId,
    providerType: record.result.providerType,
    ...(record.result.requestId ? { requestId: record.result.requestId } : {}),
    ...(record.result.rawDecision ? { rawDecision: record.result.rawDecision } : {}),
    ...(record.originalText !== undefined ? { originalText: record.originalText } : {}),
    ...(record.fileId ? { fileId: record.fileId } : {}),
    ...(record.audioId ? { audioId: record.audioId } : {}),
    ...(record.contentHash ? { contentHash: record.contentHash } : {}),
    ...(record.sourceName ? { sourceName: record.sourceName } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    checkedAtMs: record.checkedAtMs,
    ...(record.expiresAtMs !== undefined ? { expiresAtMs: record.expiresAtMs } : {})
  };
}

export type StoredContentSafetySubjectKind = ModerationSubjectKind;
