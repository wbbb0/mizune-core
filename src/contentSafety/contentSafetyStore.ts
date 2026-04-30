import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  subjectKind: z.enum(["text", "image", "emoji", "audio_transcript", "file", "local_media"]),
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
  private readonly filePath: string;
  private cached: ContentSafetyFile | null = null;
  private cachedMtimeMs: number | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, private readonly logger: Logger) {
    this.filePath = join(dataDir, "content-safety", "results.json");
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.readFile();
  }

  async upsert(record: ContentSafetyAuditRecord): Promise<void> {
    await this.withWriteLock(async () => {
      const current = await this.readFile();
      const records = current.records.filter((item) => item.key !== record.key);
      records.push(record);
      await this.writeFile({ version: 1, records });
    });
  }

  async getByKey(key: string): Promise<ContentSafetyAuditRecord | null> {
    const current = await this.readFile();
    return current.records.find((item) => item.key === key) ?? null;
  }

  async getByFileId(fileId: string): Promise<ContentSafetyAuditRecord | null> {
    const current = await this.readFile();
    return [...current.records].reverse().find((item) => item.fileId === fileId) ?? null;
  }

  async listBySessionId(sessionId: string): Promise<ContentSafetyAuditView[]> {
    const current = await this.readFile();
    return current.records
      .filter((item) => item.sessionId === sessionId)
      .map(toAuditView)
      .sort((left, right) => right.checkedAtMs - left.checkedAtMs);
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

  private async readFile(): Promise<ContentSafetyFile> {
    try {
      const fileStat = await stat(this.filePath);
      if (this.cached && this.cachedMtimeMs === fileStat.mtimeMs) {
        return this.cached;
      }
      const raw = await readFile(this.filePath, "utf8");
      const parsed = contentSafetyFileSchema.parse(JSON.parse(raw));
      this.cached = parsed;
      this.cachedMtimeMs = fileStat.mtimeMs;
      return parsed;
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        this.logger.warn({ error }, "content_safety_store_load_failed");
      }
      const empty: ContentSafetyFile = { version: 1, records: [] };
      this.cached = empty;
      this.cachedMtimeMs = null;
      return empty;
    }
  }

  private async writeFile(value: ContentSafetyFile): Promise<void> {
    const validated = contentSafetyFileSchema.parse(value);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
    this.cached = validated;
    try {
      this.cachedMtimeMs = (await stat(this.filePath)).mtimeMs;
    } catch {
      this.cachedMtimeMs = null;
    }
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
