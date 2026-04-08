import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fetch as undiciFetch } from "undici";
import type { Logger } from "pino";
import sharp from "sharp";
import type { AppConfig } from "#config/config.ts";
import { fetchWithProxy, type ProxyConsumer } from "#services/proxy/index.ts";
import type { WorkspaceService } from "./workspaceService.ts";
import type { WorkspaceStoredFileKind, WorkspaceStoredFileOrigin, WorkspaceStoredFileRecord } from "./types.ts";

const FILE_INDEX_FILE = "files.json";

export class MediaWorkspace {
  private readonly workspaceRootDir: string;
  private readonly fileIndexPath: string;
  private readonly mediaDir: string;
  private readonly writeChain = new Map<string, Promise<void>>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly workspaceService: WorkspaceService
  ) {
    this.workspaceRootDir = join(this.workspaceService.rootDir, "workspace");
    this.fileIndexPath = join(this.workspaceRootDir, FILE_INDEX_FILE);
    this.mediaDir = join(this.workspaceRootDir, "media");
  }

  async init(): Promise<void> {
    if (!this.config.workspace.enabled) {
      return;
    }
    await mkdir(this.mediaDir, { recursive: true });
    if (!(await fileExists(this.fileIndexPath))) {
      await this.writeFiles([]);
    }
  }

  async listFiles(): Promise<WorkspaceStoredFileRecord[]> {
    return this.readFiles();
  }

  async getFile(fileId: string): Promise<WorkspaceStoredFileRecord | null> {
    const normalizedFileId = String(fileId ?? "").trim();
    if (!normalizedFileId) {
      return null;
    }
    const files = await this.readFiles();
    return files.find((item) => item.fileId === normalizedFileId) ?? null;
  }

  async getMany(fileIds: string[]): Promise<WorkspaceStoredFileRecord[]> {
    const wanted = new Set(fileIds.map((item) => String(item ?? "").trim()).filter(Boolean));
    if (wanted.size === 0) {
      return [];
    }
    const files = await this.readFiles();
    return files.filter((item) => wanted.has(item.fileId));
  }

  async importBuffer(input: {
    buffer: Buffer;
    sourceName?: string;
    mimeType?: string;
    kind: WorkspaceStoredFileKind;
    origin: WorkspaceStoredFileOrigin;
    sourceContext?: Record<string, string | number | boolean | null>;
  }): Promise<WorkspaceStoredFileRecord> {
    const kind = await normalizeStoredFileKind(input.kind, input.buffer, input.sourceName, input.mimeType);
    await validateStoredFileBuffer(kind, input.buffer);
    const sourceName = normalizeSourceName(input.sourceName, kind);
    const mimeType = normalizeMimeType(input.mimeType, kind);
    const ext = extname(sourceName) || extensionFromMimeType(mimeType) || defaultExtension(kind);
    const fileId = buildStoredFileId();
    const fileRef = buildStoredFileRef(fileId, input.origin, kind, ext);
    const relativePath = join("workspace", "media", fileRef);
    const absolutePath = this.workspaceService.resolvePath(relativePath).absolutePath;
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.buffer);
    const record: WorkspaceStoredFileRecord = {
      fileId,
      fileRef,
      kind,
      origin: input.origin,
      workspacePath: relativePath.replaceAll("\\", "/"),
      sourceName,
      mimeType,
      sizeBytes: input.buffer.byteLength,
      createdAtMs: Date.now(),
      sourceContext: input.sourceContext ?? {},
      caption: null
    };
    await this.upsertFile(record);
    return record;
  }

  async importFileFromPath(input: {
    sourcePath: string;
    sourceName?: string;
    mimeType?: string;
    kind?: WorkspaceStoredFileKind;
    origin: WorkspaceStoredFileOrigin;
    sourceContext?: Record<string, string | number | boolean | null>;
  }): Promise<WorkspaceStoredFileRecord> {
    const fileStat = await stat(input.sourcePath);
    if (fileStat.size > this.config.workspace.maxUploadBytes) {
      throw new Error("Workspace import exceeds maxUploadBytes");
    }
    const sourceName = input.sourceName ?? basename(input.sourcePath);
    const kind = input.kind ?? inferStoredFileKind(sourceName, input.mimeType);
    const mimeType = normalizeMimeType(input.mimeType, kind);
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

  async importRemoteSource(input: {
    source: string;
    sourceName?: string;
    mimeType?: string;
    kind?: WorkspaceStoredFileKind;
    origin: WorkspaceStoredFileOrigin;
    proxyConsumer?: ProxyConsumer;
    sourceContext?: Record<string, string | number | boolean | null>;
  }): Promise<WorkspaceStoredFileRecord> {
    const source = String(input.source ?? "").trim();
    if (!source) {
      throw new Error("source is required");
    }
    if (/^https?:\/\//i.test(source)) {
      const response = input.proxyConsumer
        ? await fetchWithProxy(this.config, input.proxyConsumer, source)
        : await undiciFetch(source);
      if (!response.ok) {
        throw new Error(`Failed to download workspace file: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.byteLength > this.config.workspace.maxUploadBytes) {
        throw new Error("Workspace import exceeds maxUploadBytes");
      }
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

  async updateCaption(fileId: string, caption: string | null): Promise<void> {
    const file = await this.getRequiredFile(fileId);
    await this.upsertFile({
      ...file,
      caption: caption ? String(caption) : null
    });
  }

  async resolveAbsolutePath(fileId: string): Promise<string> {
    const file = await this.getRequiredFile(fileId);
    return this.workspaceService.resolvePath(file.workspacePath).absolutePath;
  }

  private async getRequiredFile(fileId: string): Promise<WorkspaceStoredFileRecord> {
    const file = await this.getFile(fileId);
    if (!file) {
      throw new Error(`Unknown workspace file: ${fileId}`);
    }
    return file;
  }

  private async upsertFile(record: WorkspaceStoredFileRecord): Promise<void> {
    await this.withWriteLock(record.fileId, async () => {
      const files = await this.readFiles();
      const next = files.filter((item) => item.fileId !== record.fileId);
      next.push(record);
      next.sort((left, right) => right.createdAtMs - left.createdAtMs);
      await this.writeFiles(next);
    });
  }

  private async readFiles(): Promise<WorkspaceStoredFileRecord[]> {
    try {
      const raw = await readFile(this.fileIndexPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed
          .filter(isWorkspaceStoredFileRecord)
          .map((item) => item.fileRef
            ? item
            : {
                ...item,
                fileRef: item.workspacePath.split("/").at(-1) ?? buildStoredFileRef(
                  item.fileId,
                  item.origin,
                  item.kind,
                  extname(item.sourceName) || extname(item.workspacePath) || extensionFromMimeType(item.mimeType) || defaultExtension(item.kind)
                )
              })
        : [];
    } catch {
      return [];
    }
  }

  private async writeFiles(records: WorkspaceStoredFileRecord[]): Promise<void> {
    await mkdir(dirname(this.fileIndexPath), { recursive: true });
    await writeFile(this.fileIndexPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }

  private async withWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChain.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writeChain.set(key, previous.then(() => current));
    try {
      await previous;
      return await operation();
    } finally {
      release?.();
      if (this.writeChain.get(key) === current) {
        this.writeChain.delete(key);
      }
    }
  }
}

function buildStoredFileId(): string {
  return `file_${randomUUID().replaceAll("-", "")}`;
}

function normalizeSourceName(sourceName: string | undefined, kind: WorkspaceStoredFileKind): string {
  const normalized = String(sourceName ?? "").trim();
  if (normalized) {
    return normalized;
  }
  return `workspace-${kind}${defaultExtension(kind)}`;
}

function buildStoredFileRef(
  fileId: string,
  origin: WorkspaceStoredFileOrigin,
  kind: WorkspaceStoredFileKind,
  extension: string
): string {
  const prefix = originPrefix(origin) ?? kindPrefix(kind);
  const shortId = fileId.replace(/^file_/, "").slice(0, 8) || "unknown";
  return `${prefix}_${shortId}${extension}`;
}

function originPrefix(origin: WorkspaceStoredFileOrigin): string | null {
  if (origin === "comfy_generated") return "comfy";
  if (origin === "browser_download") return "web";
  if (origin === "browser_screenshot") return "shot";
  if (origin === "workspace_import") return "ws";
  if (origin === "user_upload") return "upload";
  if (origin === "chat_message") return "chat";
  return null;
}

function kindPrefix(kind: WorkspaceStoredFileKind): string {
  if (kind === "image") return "img";
  if (kind === "animated_image") return "gif";
  if (kind === "video") return "vid";
  if (kind === "audio") return "aud";
  return "file";
}

function normalizeMimeType(mimeType: string | undefined, kind: WorkspaceStoredFileKind): string {
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

function defaultExtension(kind: WorkspaceStoredFileKind): string {
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

function inferStoredFileKind(sourceName: string, mimeType?: string): WorkspaceStoredFileKind {
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

function inferFilenameFromUrl(source: string, mimeType?: string, kind?: WorkspaceStoredFileKind): string {
  const pathname = new URL(source).pathname;
  const existing = basename(pathname);
  if (existing && existing !== "/") {
    return existing;
  }
  const resolvedKind = kind ?? inferStoredFileKind("file", mimeType);
  return `download${extensionFromMimeType(String(mimeType ?? "")) ?? defaultExtension(resolvedKind)}`;
}

async function normalizeStoredFileKind(
  kind: WorkspaceStoredFileKind,
  buffer: Buffer,
  sourceName?: string,
  mimeType?: string
): Promise<WorkspaceStoredFileKind> {
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

async function validateStoredFileBuffer(kind: WorkspaceStoredFileKind, buffer: Buffer): Promise<void> {
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

function isWorkspaceStoredFileRecord(value: unknown): value is WorkspaceStoredFileRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.fileId === "string"
    && (candidate.fileRef == null || typeof candidate.fileRef === "string")
    && typeof candidate.kind === "string"
    && typeof candidate.origin === "string"
    && typeof candidate.workspacePath === "string"
    && typeof candidate.sourceName === "string"
    && typeof candidate.mimeType === "string"
    && typeof candidate.sizeBytes === "number"
    && typeof candidate.createdAtMs === "number";
}

async function fileExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true).catch(() => false);
}
