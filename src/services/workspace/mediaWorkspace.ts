import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fetch as undiciFetch } from "undici";
import type { Logger } from "pino";
import sharp from "sharp";
import type { AppConfig } from "#config/config.ts";
import { fetchWithProxy, type ProxyConsumer } from "#services/proxy/index.ts";
import type { WorkspaceService } from "./workspaceService.ts";
import type { WorkspaceAssetKind, WorkspaceAssetOrigin, WorkspaceAssetRecord } from "./types.ts";

const ASSET_INDEX_FILE = "assets.json";

export class MediaWorkspace {
  private readonly workspaceRootDir: string;
  private readonly assetIndexPath: string;
  private readonly mediaDir: string;
  private readonly writeChain = new Map<string, Promise<void>>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly workspaceService: WorkspaceService
  ) {
    this.workspaceRootDir = join(this.workspaceService.rootDir, "workspace");
    this.assetIndexPath = join(this.workspaceRootDir, ASSET_INDEX_FILE);
    this.mediaDir = join(this.workspaceRootDir, "media");
  }

  async init(): Promise<void> {
    if (!this.config.workspace.enabled) {
      return;
    }
    await mkdir(this.mediaDir, { recursive: true });
    if (!(await fileExists(this.assetIndexPath))) {
      await this.writeAssets([]);
    }
  }

  async listAssets(): Promise<WorkspaceAssetRecord[]> {
    return this.readAssets();
  }

  async getAsset(assetId: string): Promise<WorkspaceAssetRecord | null> {
    const normalizedAssetId = String(assetId ?? "").trim();
    if (!normalizedAssetId) {
      return null;
    }
    const assets = await this.readAssets();
    return assets.find((item) => item.assetId === normalizedAssetId) ?? null;
  }

  async getMany(assetIds: string[]): Promise<WorkspaceAssetRecord[]> {
    const wanted = new Set(assetIds.map((item) => String(item ?? "").trim()).filter(Boolean));
    if (wanted.size === 0) {
      return [];
    }
    const assets = await this.readAssets();
    return assets.filter((item) => wanted.has(item.assetId));
  }

  async importBuffer(input: {
    buffer: Buffer;
    filename?: string;
    mimeType?: string;
    kind: WorkspaceAssetKind;
    origin: WorkspaceAssetOrigin;
    sourceContext?: Record<string, string | number | boolean | null>;
  }): Promise<WorkspaceAssetRecord> {
    const kind = await normalizeAssetKind(input.kind, input.buffer, input.filename, input.mimeType);
    await validateAssetBuffer(kind, input.buffer);
    const filename = normalizeFilename(input.filename, kind);
    const mimeType = normalizeMimeType(input.mimeType, kind);
    const ext = extname(filename) || extensionFromMimeType(mimeType) || defaultExtension(kind);
    const assetId = buildAssetId();
    const displayName = buildAssetDisplayName(assetId, input.origin, kind, ext);
    const storedFilename = displayName;
    const relativePath = join("workspace", "media", storedFilename);
    const absolutePath = this.workspaceService.resolvePath(relativePath).absolutePath;
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.buffer);
    const record: WorkspaceAssetRecord = {
      assetId,
      displayName,
      kind,
      origin: input.origin,
      storagePath: relativePath.replaceAll("\\", "/"),
      filename,
      mimeType,
      sizeBytes: input.buffer.byteLength,
      createdAtMs: Date.now(),
      sourceContext: input.sourceContext ?? {},
      caption: null
    };
    await this.upsertAsset(record);
    return record;
  }

  async importFileFromPath(input: {
    sourcePath: string;
    filename?: string;
    mimeType?: string;
    kind?: WorkspaceAssetKind;
    origin: WorkspaceAssetOrigin;
    sourceContext?: Record<string, string | number | boolean | null>;
  }): Promise<WorkspaceAssetRecord> {
    const fileStat = await stat(input.sourcePath);
    if (fileStat.size > this.config.workspace.maxUploadBytes) {
      throw new Error("Workspace import exceeds maxUploadBytes");
    }
    const filename = input.filename ?? basename(input.sourcePath);
    const kind = input.kind ?? inferAssetKind(filename, input.mimeType);
    const mimeType = normalizeMimeType(input.mimeType, kind);
    const buffer = await readFile(input.sourcePath);
    return this.importBuffer({
      buffer,
      filename,
      mimeType,
      kind,
      origin: input.origin,
      ...(input.sourceContext ? { sourceContext: input.sourceContext } : {})
    });
  }

  async importRemoteSource(input: {
    source: string;
    filename?: string;
    mimeType?: string;
    kind?: WorkspaceAssetKind;
    origin: WorkspaceAssetOrigin;
    proxyConsumer?: ProxyConsumer;
    sourceContext?: Record<string, string | number | boolean | null>;
  }): Promise<WorkspaceAssetRecord> {
    const source = String(input.source ?? "").trim();
    if (!source) {
      throw new Error("source is required");
    }
    if (/^https?:\/\//i.test(source)) {
      const response = input.proxyConsumer
        ? await fetchWithProxy(this.config, input.proxyConsumer, source)
        : await undiciFetch(source);
      if (!response.ok) {
        throw new Error(`Failed to download workspace asset: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.byteLength > this.config.workspace.maxUploadBytes) {
        throw new Error("Workspace import exceeds maxUploadBytes");
      }
      const mimeType = input.mimeType ?? response.headers.get("content-type") ?? undefined;
      const filename = input.filename ?? inferFilenameFromUrl(source, mimeType, input.kind);
      return this.importBuffer({
        buffer,
        filename,
        kind: input.kind ?? inferAssetKind(filename, mimeType),
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
      ...(input.filename ? { filename: input.filename } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      sourceContext: {
        source,
        ...(input.sourceContext ?? {})
      }
    });
  }

  async updateCaption(assetId: string, caption: string | null): Promise<void> {
    const asset = await this.getRequiredAsset(assetId);
    await this.upsertAsset({
      ...asset,
      caption: caption ? String(caption) : null
    });
  }

  async resolveAbsolutePath(assetId: string): Promise<string> {
    const asset = await this.getRequiredAsset(assetId);
    return this.workspaceService.resolvePath(asset.storagePath).absolutePath;
  }

  private async getRequiredAsset(assetId: string): Promise<WorkspaceAssetRecord> {
    const asset = await this.getAsset(assetId);
    if (!asset) {
      throw new Error(`Unknown workspace asset: ${assetId}`);
    }
    return asset;
  }

  private async upsertAsset(record: WorkspaceAssetRecord): Promise<void> {
    await this.withWriteLock(record.assetId, async () => {
      const assets = await this.readAssets();
      const next = assets.filter((item) => item.assetId !== record.assetId);
      next.push(record);
      next.sort((left, right) => right.createdAtMs - left.createdAtMs);
      await this.writeAssets(next);
    });
  }

  private async readAssets(): Promise<WorkspaceAssetRecord[]> {
    try {
      const raw = await readFile(this.assetIndexPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed
          .filter(isWorkspaceAssetRecord)
          .map((item) => item.displayName
            ? item
            : {
                ...item,
                displayName: item.storagePath.split("/").at(-1) ?? buildAssetDisplayName(
                  item.assetId,
                  item.origin,
                  item.kind,
                  extname(item.filename) || extname(item.storagePath) || extensionFromMimeType(item.mimeType) || defaultExtension(item.kind)
                )
              })
        : [];
    } catch {
      return [];
    }
  }

  private async writeAssets(records: WorkspaceAssetRecord[]): Promise<void> {
    await mkdir(dirname(this.assetIndexPath), { recursive: true });
    await writeFile(this.assetIndexPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
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

function buildAssetId(): string {
  return `asset_${randomUUID().replaceAll("-", "")}`;
}

function normalizeFilename(filename: string | undefined, kind: WorkspaceAssetKind): string {
  const normalized = String(filename ?? "").trim();
  if (normalized) {
    return normalized;
  }
  return `workspace-${kind}${defaultExtension(kind)}`;
}

function buildAssetDisplayName(
  assetId: string,
  origin: WorkspaceAssetOrigin,
  kind: WorkspaceAssetKind,
  extension: string
): string {
  const prefix = originPrefix(origin) ?? kindPrefix(kind);
  const shortId = assetId.replace(/^asset_/, "").slice(0, 8) || "unknown";
  return `${prefix}_${shortId}${extension}`;
}

function originPrefix(origin: WorkspaceAssetOrigin): string | null {
  if (origin === "comfy_generated") return "comfy";
  if (origin === "browser_download") return "web";
  if (origin === "browser_screenshot") return "shot";
  if (origin === "workspace_import") return "ws";
  if (origin === "user_upload") return "upload";
  if (origin === "chat_message") return "chat";
  return null;
}

function kindPrefix(kind: WorkspaceAssetKind): string {
  if (kind === "image") return "img";
  if (kind === "animated_image") return "gif";
  if (kind === "video") return "vid";
  if (kind === "audio") return "aud";
  return "file";
}

function normalizeMimeType(mimeType: string | undefined, kind: WorkspaceAssetKind): string {
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

function defaultExtension(kind: WorkspaceAssetKind): string {
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

function inferAssetKind(filename: string, mimeType?: string): WorkspaceAssetKind {
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
  const ext = extname(filename).toLowerCase();
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

function inferFilenameFromUrl(source: string, mimeType?: string, kind?: WorkspaceAssetKind): string {
  const pathname = new URL(source).pathname;
  const existing = basename(pathname);
  if (existing && existing !== "/") {
    return existing;
  }
  const resolvedKind = kind ?? inferAssetKind("asset", mimeType);
  return `download${extensionFromMimeType(String(mimeType ?? "")) ?? defaultExtension(resolvedKind)}`;
}

async function normalizeAssetKind(
  kind: WorkspaceAssetKind,
  buffer: Buffer,
  filename?: string,
  mimeType?: string
): Promise<WorkspaceAssetKind> {
  if (kind !== "image") {
    return kind;
  }
  const inferred = inferAssetKind(filename ?? "", mimeType);
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

async function validateAssetBuffer(kind: WorkspaceAssetKind, buffer: Buffer): Promise<void> {
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

function isWorkspaceAssetRecord(value: unknown): value is WorkspaceAssetRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.assetId === "string"
    && (candidate.displayName == null || typeof candidate.displayName === "string")
    && typeof candidate.kind === "string"
    && typeof candidate.origin === "string"
    && typeof candidate.storagePath === "string"
    && typeof candidate.filename === "string"
    && typeof candidate.mimeType === "string"
    && typeof candidate.sizeBytes === "number"
    && typeof candidate.createdAtMs === "number";
}

async function fileExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true).catch(() => false);
}
