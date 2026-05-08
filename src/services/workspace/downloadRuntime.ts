import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { fetch as undiciFetch } from "undici";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { fetchWithProxy, type ProxyConsumer } from "#services/proxy/index.ts";
import type { ChatFileKind, ChatFileOrigin, ChatFileRecord } from "./types.ts";
import type { ChatFileStore } from "./chatFileStore.ts";
import type { ShellRunOwner } from "#services/shell/types.ts";

const DEFAULT_FOREGROUND_WAIT_MS = 10000;
const SETTLED_TASK_RETENTION_MS = 30 * 60 * 1000;
const MAX_SETTLED_TASKS = 50;

export interface DownloadStartInput {
  sourceUrl: string;
  sourceName?: string;
  kind?: ChatFileKind;
  origin: ChatFileOrigin;
  sourceContext?: Record<string, string | number | boolean | null>;
  proxyConsumer?: ProxyConsumer;
  owner?: ShellRunOwner;
  foregroundWaitMs?: number;
}

export interface DownloadRuntimeSnapshot {
  ok: true;
  resource_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  source_url: string;
  source_name: string | null;
  origin: ChatFileOrigin;
  downloaded_bytes: number;
  total_bytes: number | null;
  percent: number | null;
  mime_type: string | null;
  file_id: string | null;
  file_ref: string | null;
  asset_ref: string | null;
  chat_file_path: string | null;
  kind: ChatFileKind | null;
  size_bytes: number | null;
  error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  background_followup?: {
    will_trigger_on_complete: boolean;
    message: string;
  };
}

export type DownloadRuntimeEvent =
  | {
      kind: "download_completed";
      owner: ShellRunOwner;
      resourceId: string;
      sourceUrl: string;
      file: ChatFileRecord;
    }
  | {
      kind: "download_failed";
      owner: ShellRunOwner;
      resourceId: string;
      sourceUrl: string;
      error: string;
    };

export type DownloadRuntimeEventHandler = (event: DownloadRuntimeEvent) => void | Promise<void>;

interface DownloadTaskState {
  resourceId: string;
  status: DownloadRuntimeSnapshot["status"];
  sourceUrl: string;
  sourceName: string | null;
  origin: ChatFileOrigin;
  sourceContext: Record<string, string | number | boolean | null>;
  proxyConsumer?: ProxyConsumer;
  owner: ShellRunOwner | null;
  requestedKind: ChatFileKind | null;
  mimeType: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  file: ChatFileRecord | null;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  abortController: AbortController;
  tempPath: string;
  completion: Promise<void>;
  notifyOnSettled: boolean;
}

export class DownloadRuntime {
  private readonly tasks = new Map<string, DownloadTaskState>();
  private readonly tmpReady: Promise<void>;
  private eventHandler: DownloadRuntimeEventHandler | null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly dataDir: string,
    private readonly chatFileStore: ChatFileStore,
    options?: { onEvent?: DownloadRuntimeEventHandler | null }
  ) {
    this.eventHandler = options?.onEvent ?? null;
    this.tmpReady = this.cleanupStaleTempFiles();
  }

  setEventHandler(handler: DownloadRuntimeEventHandler | null): void {
    this.eventHandler = handler;
  }

  async start(input: DownloadStartInput): Promise<DownloadRuntimeSnapshot> {
    await this.tmpReady;
    if (!this.config.chatFiles.enabled) {
      throw new Error("assets are disabled");
    }
    this.cleanupSettledTasks();
    const sourceUrl = validateHttpUrl(input.sourceUrl);
    const now = Date.now();
    const resourceId = `res_download_${randomUUID().replaceAll("-", "")}`;
    const tempDir = join(this.dataDir, "downloads", "tmp");
    await mkdir(tempDir, { recursive: true });
    const state: DownloadTaskState = {
      resourceId,
      status: "running",
      sourceUrl,
      sourceName: normalizeOptionalString(input.sourceName) ?? null,
      origin: input.origin,
      sourceContext: input.sourceContext ?? {},
      ...(input.proxyConsumer ? { proxyConsumer: input.proxyConsumer } : {}),
      owner: input.owner ?? null,
      requestedKind: input.kind ?? null,
      mimeType: null,
      downloadedBytes: 0,
      totalBytes: null,
      file: null,
      error: null,
      createdAtMs: now,
      updatedAtMs: now,
      abortController: new AbortController(),
      tempPath: join(tempDir, `${resourceId}.download`),
      completion: Promise.resolve(),
      notifyOnSettled: false
    };
    state.completion = this.runDownload(state);
    this.tasks.set(resourceId, state);

    const waitMs = normalizeWaitMs(input.foregroundWaitMs);
    await Promise.race([
      state.completion.catch(() => undefined),
      delay(waitMs)
    ]);
    const stillRunning = state.status === "running";
    if (stillRunning && state.owner) {
      state.notifyOnSettled = true;
    }
    return this.snapshot(state, stillRunning);
  }

  list(): DownloadRuntimeSnapshot[] {
    this.cleanupSettledTasks();
    return Array.from(this.tasks.values())
      .map((state) => this.snapshot(state, false))
      .sort((left, right) => right.updated_at_ms - left.updated_at_ms);
  }

  read(resourceId: string): DownloadRuntimeSnapshot | null {
    this.cleanupSettledTasks();
    const state = this.tasks.get(resourceId);
    return state ? this.snapshot(state, false) : null;
  }

  async cancel(resourceId: string): Promise<DownloadRuntimeSnapshot | null> {
    const state = this.tasks.get(resourceId);
    if (!state) {
      return null;
    }
    if (state.status === "running") {
      state.status = "cancelled";
      state.error = "download cancelled";
      state.updatedAtMs = Date.now();
      state.abortController.abort();
      await rm(state.tempPath, { force: true }).catch(() => undefined);
    }
    return this.snapshot(state, false);
  }

  private async runDownload(state: DownloadTaskState): Promise<void> {
    try {
      const response = state.proxyConsumer
        ? await fetchWithProxy(this.config, state.proxyConsumer, state.sourceUrl, { signal: state.abortController.signal })
        : await undiciFetch(state.sourceUrl, { signal: state.abortController.signal });
      if (!response.ok) {
        throw new Error(`download failed: ${response.status} ${response.statusText}`);
      }
      state.mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? null;
      state.totalBytes = parseContentLength(response.headers.get("content-length"));
      if (state.totalBytes != null && state.totalBytes > this.config.chatFiles.maxUploadBytes) {
        throw new Error("download exceeds chatFiles.maxUploadBytes");
      }
      state.sourceName = state.sourceName ?? inferFilenameFromHeadersOrUrl(response.headers.get("content-disposition"), state.sourceUrl);
      state.updatedAtMs = Date.now();

      const body = response.body;
      if (!body) {
        throw new Error("download response body is empty");
      }
      await this.writeResponseBody(state, body as AsyncIterable<Uint8Array>);

      if (state.downloadedBytes > this.config.chatFiles.maxUploadBytes) {
        throw new Error("download exceeds chatFiles.maxUploadBytes");
      }
      this.throwIfCancelled(state);

      const file = await this.chatFileStore.importFileFromPath({
        sourcePath: state.tempPath,
        origin: state.origin,
        sourceContext: {
          source_url: state.sourceUrl,
          ...state.sourceContext
        },
        ...(state.sourceName ? { sourceName: state.sourceName } : {}),
        ...(state.mimeType ? { mimeType: state.mimeType } : {}),
        ...(state.requestedKind ? { kind: state.requestedKind } : {})
      });
      if (this.isCancelled(state)) {
        await this.chatFileStore.deleteFile(file.fileId).catch((cleanupError) => {
          this.logger.warn({ cleanupError, fileId: file.fileId, resourceId: state.resourceId }, "download_runtime_cancel_import_cleanup_failed");
        });
        throw new DownloadCancelledError();
      }
      state.file = file;
      state.status = "completed";
      state.updatedAtMs = Date.now();
      await rm(state.tempPath, { force: true }).catch(() => undefined);
      if (state.owner && state.notifyOnSettled) {
        this.emitEvent({
          kind: "download_completed",
          owner: state.owner,
          resourceId: state.resourceId,
          sourceUrl: state.sourceUrl,
          file
        });
      }
    } catch (error) {
      if (state.status !== "cancelled") {
        state.status = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        state.updatedAtMs = Date.now();
        await rm(state.tempPath, { force: true }).catch(() => undefined);
        this.logger.warn({ error, resourceId: state.resourceId, sourceUrl: state.sourceUrl }, "download_runtime_failed");
        if (state.owner && state.notifyOnSettled) {
          this.emitEvent({
            kind: "download_failed",
            owner: state.owner,
            resourceId: state.resourceId,
            sourceUrl: state.sourceUrl,
            error: state.error
          });
        }
      }
    }
  }

  private async writeResponseBody(state: DownloadTaskState, body: AsyncIterable<Uint8Array>): Promise<void> {
    const output = createWriteStream(state.tempPath);
    let streamError: Error | null = null;
    const onError = (error: Error) => {
      streamError = error;
    };
    output.on("error", onError);
    let closed = false;
    try {
      for await (const chunk of body) {
        this.throwIfCancelled(state);
        if (streamError) {
          throw streamError;
        }
        const buffer = Buffer.from(chunk);
        state.downloadedBytes += buffer.byteLength;
        state.updatedAtMs = Date.now();
        if (state.downloadedBytes > this.config.chatFiles.maxUploadBytes) {
          state.abortController.abort();
          throw new Error("download exceeds chatFiles.maxUploadBytes");
        }
        await writeChunk(output, buffer);
        if (streamError) {
          throw streamError;
        }
      }
      output.end();
      await waitForStreamClose(output);
      closed = true;
    } finally {
      output.off("error", onError);
      if (!closed) {
        output.destroy();
      }
    }
  }

  private snapshot(state: DownloadTaskState, includeBackgroundFollowup: boolean): DownloadRuntimeSnapshot {
    const percent = state.totalBytes && state.totalBytes > 0
      ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 1000) / 10)
      : null;
    return {
      ok: true,
      resource_id: state.resourceId,
      status: state.status,
      source_url: state.sourceUrl,
      source_name: state.file?.sourceName ?? state.sourceName,
      origin: state.origin,
      downloaded_bytes: state.downloadedBytes,
      total_bytes: state.totalBytes,
      percent,
      mime_type: state.file?.mimeType ?? state.mimeType,
      file_id: state.file?.fileId ?? null,
      file_ref: state.file?.fileRef ?? null,
      asset_ref: state.file?.fileRef ?? null,
      chat_file_path: state.file?.chatFilePath ?? null,
      kind: state.file?.kind ?? state.requestedKind,
      size_bytes: state.file?.sizeBytes ?? null,
      error: state.error,
      created_at_ms: state.createdAtMs,
      updated_at_ms: state.updatedAtMs,
      ...(includeBackgroundFollowup && state.owner ? {
        background_followup: {
          will_trigger_on_complete: true,
          message: "下载仍在后台进行；完成或失败后会自动作为内部回调再次触发。"
        }
      } : {})
    };
  }

  private emitEvent(event: DownloadRuntimeEvent): void {
    Promise.resolve(this.eventHandler?.(event)).catch((error) => {
      this.logger.error({ error, eventKind: event.kind, resourceId: event.resourceId }, "download_runtime_event_failed");
    });
  }

  private isCancelled(state: DownloadTaskState): boolean {
    return state.status === "cancelled" || state.abortController.signal.aborted;
  }

  private throwIfCancelled(state: DownloadTaskState): void {
    if (this.isCancelled(state)) {
      throw new DownloadCancelledError();
    }
  }

  private cleanupSettledTasks(): void {
    const now = Date.now();
    const settled = Array.from(this.tasks.values())
      .filter((state) => state.status !== "running")
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    const keep = new Set(settled.slice(0, MAX_SETTLED_TASKS).map((state) => state.resourceId));
    for (const state of settled) {
      if (keep.has(state.resourceId) && now - state.updatedAtMs <= SETTLED_TASK_RETENTION_MS) {
        continue;
      }
      this.tasks.delete(state.resourceId);
    }
  }

  private async cleanupStaleTempFiles(): Promise<void> {
    const tempDir = join(this.dataDir, "downloads", "tmp");
    await rm(tempDir, { recursive: true, force: true }).catch((error) => {
      this.logger.warn({ error, tempDir }, "download_runtime_tmp_cleanup_failed");
    });
    await mkdir(tempDir, { recursive: true }).catch((error) => {
      this.logger.warn({ error, tempDir }, "download_runtime_tmp_prepare_failed");
    });
  }
}

class DownloadCancelledError extends Error {
  constructor() {
    super("download cancelled");
  }
}

async function writeChunk(output: WriteStream, buffer: Buffer): Promise<void> {
  if (output.destroyed) {
    throw new Error("download output stream is closed");
  }
  if (output.write(buffer)) {
    return;
  }
  await Promise.race([
    once(output, "drain"),
    once(output, "error").then(([error]) => {
      throw error;
    })
  ]);
}

async function waitForStreamClose(output: WriteStream): Promise<void> {
  await Promise.race([
    once(output, "finish"),
    once(output, "error").then(([error]) => {
      throw error;
    })
  ]);
}

function validateHttpUrl(value: string): string {
  const normalized = String(value ?? "").trim();
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("download sourceUrl must be an absolute http or https URL");
  }
  return parsed.toString();
}

function normalizeWaitMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value == null || value < 0) {
    return DEFAULT_FOREGROUND_WAIT_MS;
  }
  return Math.min(60000, Math.floor(value));
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function parseContentLength(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function inferFilenameFromHeadersOrUrl(contentDisposition: string | null, sourceUrl: string): string {
  const fromHeader = parseContentDispositionFilename(contentDisposition);
  if (fromHeader) {
    return fromHeader;
  }
  const pathname = new URL(sourceUrl).pathname;
  const fromPath = basename(pathname);
  return fromPath && fromPath !== "/" ? fromPath : "download.bin";
}

function parseContentDispositionFilename(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (utf8) {
    return decodeURIComponent(utf8).trim() || null;
  }
  const plain = /filename="?([^";]+)"?/i.exec(value)?.[1];
  return plain?.trim() || null;
}
