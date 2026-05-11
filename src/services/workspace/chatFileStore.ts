import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize } from "node:path";
import { fetch as undiciFetch, type Response as UndiciResponse } from "undici";
import type { Logger } from "pino";
import sharp from "sharp";
import type { AppConfig } from "#config/config.ts";
import { s } from "#data/schema/index.ts";
import type { SqliteDatabase } from "#data/sqlite/sqliteService.ts";
import { AssetsDatabase } from "#data/assets/assetsDatabase.ts";
import { fetchWithProxy, type ProxyConsumer } from "#services/proxy/index.ts";
import type { LocalFileService } from "./localFileService.ts";
import type { ChatFileCaptionStatus, ChatFileKind, ChatFileOrigin, ChatFileRecord } from "./types.ts";

export const chatFileRecordRegistrySchema = s.object({
  fileId: s.string().trim().nonempty(),
  fileRef: s.string().trim().nonempty(),
  kind: s.enum(["file", "image", "animated_image", "video", "audio"] as const),
  origin: s.enum([
    "chat_message",
    "browser_download",
    "browser_screenshot",
    "comfy_generated",
    "group_file_download",
    "local_file_import",
    "user_upload"
  ] as const),
  chatFilePath: s.string().trim().nonempty(),
  sourceName: s.string().trim().nonempty(),
  mimeType: s.string().trim().nonempty(),
  sizeBytes: s.number().int().min(0),
  createdAtMs: s.number().int().min(0),
  sourceContext: s.record(s.string(), s.union([s.string(), s.number(), s.boolean(), s.literal(null)])),
  caption: s.union([s.string(), s.literal(null)]).default(null),
  captionStatus: s.enum(["missing", "queued", "ready", "failed"] as const).default("missing"),
  captionUpdatedAtMs: s.union([s.number().int().min(0), s.literal(null)]).default(null),
  captionModelRef: s.union([s.string(), s.literal(null)]).default(null),
  captionError: s.union([s.string(), s.literal(null)]).default(null)
}).strict();

function normalizeChatFilesRoot(root: string | undefined): string {
  const configuredRoot = String(root ?? "").trim() || "chat-files";
  const normalized = normalize(configuredRoot).replaceAll("\\", "/");
  const hasParentSegment = configuredRoot.split(/[\\/]+/).some((part) => part === "..");
  if (isAbsolute(configuredRoot) || /^[a-zA-Z]:[\\/]/.test(configuredRoot) || hasParentSegment) {
    throw new Error("chatFiles.root must be a relative path inside localFiles.root");
  }
  return normalized === "." ? "chat-files" : normalized;
}

export class ChatFileStore {
  private readonly storeRootPath: string;
  private readonly storeRootDir: string;
  private readonly mediaDir: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly localFileService: LocalFileService,
    assetsDataDir = localFileService.rootDir,
    private readonly assetsDatabase = new AssetsDatabase(assetsDataDir, logger)
  ) {
    this.storeRootPath = normalizeChatFilesRoot(this.config.chatFiles.root);
    this.storeRootDir = join(this.localFileService.rootDir, this.storeRootPath);
    this.mediaDir = join(this.storeRootDir, "media");
  }

  async init(): Promise<void> {
    await this.assetsDatabase.init();
    if (!this.config.chatFiles.enabled) {
      return;
    }
    await mkdir(this.mediaDir, { recursive: true });
    await this.cleanupOrphanDocumentCaches();
  }

  async listFiles(): Promise<ChatFileRecord[]> {
    return this.listAll();
  }

  async getFile(fileId: string): Promise<ChatFileRecord | null> {
    const normalizedFileId = String(fileId ?? "").trim();
    if (!normalizedFileId) {
      return null;
    }
    const db = await this.getReadyDb();
    const row = db.prepare(`
      SELECT
        file_id AS fileId,
        file_ref AS fileRef,
        kind,
        origin,
        chat_file_path AS chatFilePath,
        source_name AS sourceName,
        mime_type AS mimeType,
        size_bytes AS sizeBytes,
        created_at_ms AS createdAtMs,
        source_context_json AS sourceContextJson,
        caption,
        caption_status AS captionStatus,
        caption_updated_at_ms AS captionUpdatedAtMs,
        caption_model_ref AS captionModelRef,
        caption_error AS captionError
      FROM chat_files
      WHERE file_id = ?
    `).get(normalizedFileId) as ChatFileRow | undefined;
    return row ? rowToChatFileRecord(row) : null;
  }

  async getMany(fileIds: string[]): Promise<ChatFileRecord[]> {
    const wanted = new Set(fileIds.map((item) => String(item ?? "").trim()).filter(Boolean));
    if (wanted.size === 0) {
      return [];
    }
    const files = await this.listAll();
    return files.filter((item) => wanted.has(item.fileId));
  }

  async importBuffer(input: {
    buffer: Buffer;
    sourceName?: string;
    mimeType?: string;
    kind: ChatFileKind;
    origin: ChatFileOrigin;
    sourceContext?: Record<string, string | number | boolean | null>;
  }): Promise<ChatFileRecord> {
    if (input.buffer.byteLength > this.config.chatFiles.maxUploadBytes) {
      throw new Error("chat file import exceeds maxUploadBytes");
    }
    const kind = await normalizeStoredFileKind(input.kind, input.buffer, input.sourceName, input.mimeType);
    await validateStoredFileBuffer(kind, input.buffer);
    const sourceName = normalizeSourceName(input.sourceName, kind);
    const mimeType = normalizeMimeType(input.mimeType, kind);
    const ext = extname(sourceName) || extensionFromMimeType(mimeType) || defaultExtension(kind);
    const fileId = buildStoredFileId();
    const fileRef = buildStoredFileRef(fileId, input.origin, kind, ext);
    const relativePath = join(this.storeRootPath, "media", fileRef);
    const absolutePath = this.localFileService.resolvePath(relativePath).absolutePath;
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.buffer);
    const record: ChatFileRecord = {
      fileId,
      fileRef,
      kind,
      origin: input.origin,
      chatFilePath: relativePath.replaceAll("\\", "/"),
      sourceName,
      mimeType,
      sizeBytes: input.buffer.byteLength,
      createdAtMs: Date.now(),
      sourceContext: input.sourceContext ?? {},
      caption: null,
      captionStatus: "missing",
      captionModelRef: null,
      captionError: null
    };
    await this.upsertFile(record);
    return record;
  }

  async importFileFromPath(input: {
    sourcePath: string;
    sourceName?: string;
    mimeType?: string;
    kind?: ChatFileKind;
    origin: ChatFileOrigin;
    sourceContext?: Record<string, string | number | boolean | null>;
  }): Promise<ChatFileRecord> {
    const fileStat = await stat(input.sourcePath);
    if (fileStat.size > this.config.chatFiles.maxUploadBytes) {
      throw new Error("asset import exceeds maxUploadBytes");
    }
    const sourceName = input.sourceName ?? basename(input.sourcePath);
    const kind = input.kind ?? inferStoredFileKind(sourceName, input.mimeType);
    const mimeType = normalizeMimeType(input.mimeType, kind);
    if (kind !== "image" && kind !== "animated_image") {
      return this.importFileByCopy({
        sourcePath: input.sourcePath,
        sourceName,
        mimeType,
        kind,
        origin: input.origin,
        ...(input.sourceContext ? { sourceContext: input.sourceContext } : {})
      });
    }
    const buffer = await readFile(input.sourcePath);
    return this.importBuffer({
      buffer,
      sourceName,
      mimeType,
      kind,
      origin: input.origin,
      ...(input.sourceContext ? { sourceContext: input.sourceContext } : {})
    });
  }

  private async importFileByCopy(input: {
    sourcePath: string;
    sourceName: string;
    mimeType: string;
    kind: ChatFileKind;
    origin: ChatFileOrigin;
    sourceContext?: Record<string, string | number | boolean | null>;
  }): Promise<ChatFileRecord> {
    const ext = extname(input.sourceName) || extensionFromMimeType(input.mimeType) || defaultExtension(input.kind);
    const fileId = buildStoredFileId();
    const fileRef = buildStoredFileRef(fileId, input.origin, input.kind, ext);
    const relativePath = join(this.storeRootPath, "media", fileRef);
    const absolutePath = this.localFileService.resolvePath(relativePath).absolutePath;
    const fileStat = await stat(input.sourcePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await copyFile(input.sourcePath, absolutePath);
    const record: ChatFileRecord = {
      fileId,
      fileRef,
      kind: input.kind,
      origin: input.origin,
      chatFilePath: relativePath.replaceAll("\\", "/"),
      sourceName: input.sourceName,
      mimeType: input.mimeType,
      sizeBytes: fileStat.size,
      createdAtMs: Date.now(),
      sourceContext: input.sourceContext ?? {},
      caption: null,
      captionStatus: "missing",
      captionModelRef: null,
      captionError: null
    };
    await this.upsertFile(record);
    return record;
  }

  async importRemoteSource(input: {
    source: string;
    sourceName?: string;
    mimeType?: string;
    kind?: ChatFileKind;
    origin: ChatFileOrigin;
    proxyConsumer?: ProxyConsumer;
    sourceContext?: Record<string, string | number | boolean | null>;
  }): Promise<ChatFileRecord> {
    const source = String(input.source ?? "").trim();
    if (!source) {
      throw new Error("source is required");
    }
    if (/^https?:\/\//i.test(source)) {
      const response = input.proxyConsumer
        ? await fetchWithProxy(this.config, input.proxyConsumer, source)
        : await undiciFetch(source);
      if (!response.ok) {
        throw new Error(`failed to download asset: ${response.status} ${response.statusText}`);
      }
      const buffer = await readResponseBufferWithLimit(response, this.config.chatFiles.maxUploadBytes);
      const mimeType = input.mimeType ?? response.headers.get("content-type") ?? undefined;
      const sourceName = input.sourceName ?? inferFilenameFromUrl(source, mimeType, input.kind);
      return this.importBuffer({
        buffer,
        sourceName,
        kind: input.kind ?? inferStoredFileKind(sourceName, mimeType),
        origin: input.origin,
        ...(mimeType ? { mimeType } : {}),
        sourceContext: {
          source,
          ...(input.sourceContext ?? {})
        }
      });
    }
    return this.importFileFromPath({
      sourcePath: source,
      origin: input.origin,
      ...(input.sourceName ? { sourceName: input.sourceName } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      sourceContext: {
        source,
        ...(input.sourceContext ?? {})
      }
    });
  }

  async markCaptionsQueued(fileIds: string[]): Promise<void> {
    const wanted = new Set(fileIds.map((item) => String(item ?? "").trim()).filter(Boolean));
    if (wanted.size === 0) {
      return;
    }
    await this.withWriteLock(async () => {
      const db = await this.getReadyDb();
      const update = db.prepare(`
        UPDATE chat_files
        SET caption_status = 'queued',
            caption_error = NULL
        WHERE file_id = ?
          AND caption IS NULL
      `);
      for (const fileId of wanted) {
        update.run(fileId);
      }
    });
  }

  async updateCaption(
    fileId: string,
    caption: string | null,
    metadata?: {
      status?: ChatFileCaptionStatus | undefined;
      modelRef?: string | null | undefined;
      error?: string | null | undefined;
      updatedAtMs?: number | undefined;
    }
  ): Promise<void> {
    const normalizedCaption = caption ? String(caption) : null;
    const status = metadata?.status ?? (normalizedCaption ? "ready" : "missing");
    await this.withWriteLock(async () => {
      const file = await this.getFile(fileId);
      if (!file) {
        throw new Error(`unknown asset: ${fileId}`);
      }
      const db = await this.getReadyDb();
      db.prepare(`
        UPDATE chat_files
        SET caption = ?,
            caption_status = ?,
            caption_updated_at_ms = ?,
            caption_model_ref = ?,
            caption_error = ?
        WHERE file_id = ?
      `).run(
        normalizedCaption,
        status,
        metadata?.updatedAtMs ?? Date.now(),
        metadata?.modelRef === undefined ? file.captionModelRef ?? null : metadata.modelRef,
        metadata?.error === undefined ? null : metadata.error,
        fileId
      );
    });
  }

  async resolveAbsolutePath(fileId: string): Promise<string> {
    const file = await this.getRequiredFile(fileId);
    return this.localFileService.resolvePath(file.chatFilePath).absolutePath;
  }

  resolveDocumentCacheDirectory(fileId: string): string {
    const normalizedFileId = String(fileId ?? "").trim();
    if (!normalizedFileId) {
      throw new Error("fileId is required");
    }
    return join(this.storeRootDir, "documents", stableDocumentCacheDirectoryName(normalizedFileId));
  }

  async cleanupOrphanDocumentCaches(): Promise<{ removed: number; kept: number }> {
    const documentsDir = join(this.storeRootDir, "documents");
    const expected = new Set((await this.listFiles()).map((file) => stableDocumentCacheDirectoryName(file.fileId)));
    let entries: string[];
    try {
      entries = await readdir(documentsDir);
    } catch {
      return { removed: 0, kept: 0 };
    }
    let removed = 0;
    let kept = 0;
    for (const entry of entries) {
      if (expected.has(entry)) {
        kept += 1;
        continue;
      }
      await rm(join(documentsDir, entry), { recursive: true, force: true }).catch((error: unknown) => {
        this.logger.warn({ entry, error }, "asset_document_orphan_cache_cleanup_failed");
      });
      removed += 1;
    }
    return { removed, kept };
  }

  async deleteFile(fileId: string): Promise<boolean> {
    const file = await this.getFile(fileId);
    if (!file) {
      return false;
    }
    const absolutePath = await this.resolveAbsolutePath(fileId);
    await rm(absolutePath, { force: true });
    await rm(this.resolveDocumentCacheDirectory(fileId), { recursive: true, force: true }).catch((error: unknown) => {
      this.logger.warn({ fileId, error }, "chat_file_document_cache_cleanup_failed");
    });
    await this.withWriteLock(async () => {
      const db = await this.getReadyDb();
      db.prepare("DELETE FROM chat_files WHERE file_id = ?").run(fileId);
    });
    return true;
  }

  private async getRequiredFile(fileId: string): Promise<ChatFileRecord> {
    const file = await this.getFile(fileId);
    if (!file) {
      throw new Error(`unknown asset: ${fileId}`);
    }
    return file;
  }

  private async upsertFile(record: ChatFileRecord): Promise<void> {
    await this.withWriteLock(async () => {
      const db = await this.getReadyDb();
      db.prepare(`
        INSERT INTO chat_files (
          file_id,
          file_ref,
          kind,
          origin,
          chat_file_path,
          source_name,
          mime_type,
          size_bytes,
          created_at_ms,
          source_context_json,
          caption,
          caption_status,
          caption_updated_at_ms,
          caption_model_ref,
          caption_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_id) DO UPDATE SET
          file_ref = excluded.file_ref,
          kind = excluded.kind,
          origin = excluded.origin,
          chat_file_path = excluded.chat_file_path,
          source_name = excluded.source_name,
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          created_at_ms = excluded.created_at_ms,
          source_context_json = excluded.source_context_json,
          caption = excluded.caption,
          caption_status = excluded.caption_status,
          caption_updated_at_ms = excluded.caption_updated_at_ms,
          caption_model_ref = excluded.caption_model_ref,
          caption_error = excluded.caption_error
      `).run(...chatFileRecordToParams(record));
    });
  }

  async listRows(input: { offset?: number; limit?: number } = {}): Promise<{
    rows: ChatFileRecord[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    const db = await this.getReadyDb();
    const total = (db.prepare("SELECT COUNT(*) AS count FROM chat_files").get() as { count: number }).count;
    const rows = db.prepare(`
      SELECT
        file_id AS fileId,
        file_ref AS fileRef,
        kind,
        origin,
        chat_file_path AS chatFilePath,
        source_name AS sourceName,
        mime_type AS mimeType,
        size_bytes AS sizeBytes,
        created_at_ms AS createdAtMs,
        source_context_json AS sourceContextJson,
        caption,
        caption_status AS captionStatus,
        caption_updated_at_ms AS captionUpdatedAtMs,
        caption_model_ref AS captionModelRef,
        caption_error AS captionError
      FROM chat_files
      ORDER BY created_at_ms DESC, file_id ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as ChatFileRow[];
    return { rows: rows.map(rowToChatFileRecord), total, offset, limit };
  }

  async getRow(fileId: string): Promise<ChatFileRecord | null> {
    return this.getFile(fileId);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release: (() => void) | undefined;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous.catch(() => undefined);
      return await operation();
    } finally {
      release?.();
    }
  }

  private async getReadyDb(): Promise<SqliteDatabase> {
    await this.assetsDatabase.init();
    return this.assetsDatabase.getDb();
  }

  private async listAll(): Promise<ChatFileRecord[]> {
    const db = await this.getReadyDb();
    const rows = db.prepare(`
      SELECT
        file_id AS fileId,
        file_ref AS fileRef,
        kind,
        origin,
        chat_file_path AS chatFilePath,
        source_name AS sourceName,
        mime_type AS mimeType,
        size_bytes AS sizeBytes,
        created_at_ms AS createdAtMs,
        source_context_json AS sourceContextJson,
        caption,
        caption_status AS captionStatus,
        caption_updated_at_ms AS captionUpdatedAtMs,
        caption_model_ref AS captionModelRef,
        caption_error AS captionError
      FROM chat_files
      ORDER BY created_at_ms DESC, file_id ASC
    `).all() as ChatFileRow[];
    return rows.map(rowToChatFileRecord);
  }
}

type ChatFileRow = {
  fileId: string;
  fileRef: string;
  kind: ChatFileKind;
  origin: ChatFileOrigin;
  chatFilePath: string;
  sourceName: string;
  mimeType: string;
  sizeBytes: number;
  createdAtMs: number;
  sourceContextJson: string;
  caption: string | null;
  captionStatus: ChatFileCaptionStatus;
  captionUpdatedAtMs: number | null;
  captionModelRef: string | null;
  captionError: string | null;
};

function rowToChatFileRecord(row: ChatFileRow): ChatFileRecord {
  return {
    fileId: row.fileId,
    fileRef: row.fileRef,
    kind: row.kind,
    origin: row.origin,
    chatFilePath: row.chatFilePath,
    sourceName: row.sourceName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAtMs: row.createdAtMs,
    sourceContext: parseSourceContext(row.sourceContextJson),
    caption: row.caption,
    captionStatus: row.captionStatus,
    captionUpdatedAtMs: row.captionUpdatedAtMs,
    captionModelRef: row.captionModelRef,
    captionError: row.captionError
  };
}

function chatFileRecordToParams(record: ChatFileRecord): [
  string,
  string,
  ChatFileKind,
  ChatFileOrigin,
  string,
  string,
  string,
  number,
  number,
  string,
  string | null,
  ChatFileCaptionStatus,
  number | null,
  string | null,
  string | null
] {
  return [
    record.fileId,
    record.fileRef,
    record.kind,
    record.origin,
    record.chatFilePath,
    record.sourceName,
    record.mimeType,
    record.sizeBytes,
    record.createdAtMs,
    JSON.stringify(record.sourceContext ?? {}),
    record.caption,
    record.captionStatus ?? (record.caption ? "ready" : "missing"),
    record.captionUpdatedAtMs ?? null,
    record.captionModelRef ?? null,
    record.captionError ?? null
  ];
}

function parseSourceContext(value: string): Record<string, string | number | boolean | null> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, entry]) => (
        typeof entry === "string"
        || typeof entry === "number"
        || typeof entry === "boolean"
        || entry === null
      ))
    ) as Record<string, string | number | boolean | null>;
  } catch {
    return {};
  }
}

function buildStoredFileId(): string {
  return `file_${randomUUID().replaceAll("-", "")}`;
}

function stableDocumentCacheDirectoryName(value: string): string {
  return `id-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function normalizeSourceName(sourceName: string | undefined, kind: ChatFileKind): string {
  const normalized = String(sourceName ?? "").trim();
  if (normalized) {
    return normalized;
  }
  return `workspace-${kind}${defaultExtension(kind)}`;
}

function buildStoredFileRef(
  fileId: string,
  origin: ChatFileOrigin,
  kind: ChatFileKind,
  extension: string
): string {
  const prefix = originPrefix(origin) ?? kindPrefix(kind);
  const shortId = fileId.replace(/^file_/, "").slice(0, 8) || "unknown";
  return `${prefix}_${shortId}${extension}`;
}

function originPrefix(origin: ChatFileOrigin): string | null {
  if (origin === "comfy_generated") return "comfy";
  if (origin === "browser_download") return "web";
  if (origin === "browser_screenshot") return "shot";
  if (origin === "group_file_download") return "grp";
  if (origin === "local_file_import") return "ws";
  if (origin === "user_upload") return "upload";
  if (origin === "chat_message") return "chat";
  return null;
}

function kindPrefix(kind: ChatFileKind): string {
  if (kind === "image") return "img";
  if (kind === "animated_image") return "gif";
  if (kind === "video") return "vid";
  if (kind === "audio") return "aud";
  return "file";
}

function normalizeMimeType(mimeType: string | undefined, kind: ChatFileKind): string {
  const normalized = String(mimeType ?? "").trim().toLowerCase();
  if (normalized) {
    return normalized;
  }
  if (kind === "image") {
    return "image/png";
  }
  if (kind === "animated_image") {
    return "image/gif";
  }
  if (kind === "video") {
    return "video/mp4";
  }
  if (kind === "audio") {
    return "audio/mpeg";
  }
  return "application/octet-stream";
}

function defaultExtension(kind: ChatFileKind): string {
  if (kind === "image") {
    return ".png";
  }
  if (kind === "animated_image") {
    return ".gif";
  }
  if (kind === "video") {
    return ".mp4";
  }
  if (kind === "audio") {
    return ".mp3";
  }
  return ".bin";
}

function extensionFromMimeType(mimeType: string): string | null {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "video/mp4") return ".mp4";
  if (mimeType === "audio/mpeg") return ".mp3";
  if (mimeType === "text/plain") return ".txt";
  return null;
}

function inferStoredFileKind(sourceName: string, mimeType?: string): ChatFileKind {
  const normalizedMimeType = String(mimeType ?? "").toLowerCase();
  if (normalizedMimeType === "image/gif" || normalizedMimeType === "image/apng") {
    return "animated_image";
  }
  if (normalizedMimeType.startsWith("image/")) {
    return "image";
  }
  if (normalizedMimeType.startsWith("video/")) {
    return "video";
  }
  if (normalizedMimeType.startsWith("audio/")) {
    return "audio";
  }
  const ext = extname(sourceName).toLowerCase();
  if ([".gif", ".apng"].includes(ext)) {
    return "animated_image";
  }
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    return "image";
  }
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(ext)) {
    return "video";
  }
  if ([".mp3", ".wav", ".ogg", ".m4a"].includes(ext)) {
    return "audio";
  }
  return "file";
}

function inferFilenameFromUrl(source: string, mimeType?: string, kind?: ChatFileKind): string {
  const pathname = new URL(source).pathname;
  const existing = basename(pathname);
  if (existing && existing !== "/") {
    return existing;
  }
  const resolvedKind = kind ?? inferStoredFileKind("file", mimeType);
  return `download${extensionFromMimeType(String(mimeType ?? "")) ?? defaultExtension(resolvedKind)}`;
}

async function normalizeStoredFileKind(
  kind: ChatFileKind,
  buffer: Buffer,
  sourceName?: string,
  mimeType?: string
): Promise<ChatFileKind> {
  if (kind !== "image") {
    return kind;
  }
  const inferred = inferStoredFileKind(sourceName ?? "", mimeType);
  if (inferred !== "image") {
    return inferred;
  }
  try {
    const metadata = await sharp(buffer, { animated: true, failOn: "none" }).metadata();
    if ((metadata.pages ?? 1) > 1) {
      return "animated_image";
    }
  } catch {
    // Ignore metadata failures and fall back to static image.
  }
  return "image";
}

async function validateStoredFileBuffer(kind: ChatFileKind, buffer: Buffer): Promise<void> {
  if (kind !== "image" && kind !== "animated_image") {
    return;
  }

  try {
    const metadata = await sharp(buffer, { animated: true }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("missing image dimensions");
    }

    await sharp(buffer, { animated: true })
      .rotate()
      .resize({
        width: 1,
        height: 1,
        fit: "inside",
        withoutEnlargement: true
      })
      .toBuffer();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Workspace image validation failed: image is invalid or corrupted (${detail})`);
  }
}

async function readResponseBufferWithLimit(response: UndiciResponse, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("chat file import exceeds maxUploadBytes");
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error("chat file import exceeds maxUploadBytes");
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("chat file import exceeds maxUploadBytes");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}
