import { randomUUID } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { resolveProxyUrls, type ProxyConsumer } from "#services/proxy/index.ts";
import {
  createHttpDownloadEngine,
  type HttpDownloadCheckpoint,
  type HttpDownloadEngine,
  type HttpDownloadEvent
} from "#vendor/http-download-engine";
import type { ChatFileKind, ChatFileOrigin, ChatFileRecord } from "./types.ts";
import type { ChatFileStore } from "./chatFileStore.ts";
import type { ShellRunOwner } from "#services/shell/types.ts";

const DEFAULT_FOREGROUND_WAIT_MS = 10000;
const SETTLED_TASK_RETENTION_MS = 30 * 60 * 1000;
const MAX_SETTLED_TASKS = 50;
const MAX_DOWNLOAD_CONCURRENCY = 16;

export interface DownloadStartInput {
  sourceUrl: string;
  sourceName?: string;
  kind?: ChatFileKind;
  origin: ChatFileOrigin;
  sourceContext?: Record<string, string | number | boolean | null>;
  proxyConsumer?: ProxyConsumer;
  owner?: ShellRunOwner;
  foregroundWaitMs?: number;
  concurrency?: number;
}

export type DownloadRuntimeStatus = "running" | "paused" | "completed" | "failed" | "cancelled";
export type DownloadRuntimePhase = "queued" | "probing" | "transferring" | "finalizing" | "importing";

export interface DownloadRuntimeSnapshot {
  ok: true;
  resource_id: string;
  status: DownloadRuntimeStatus;
  phase: DownloadRuntimePhase;
  source_url: string;
  source_name: string | null;
  origin: ChatFileOrigin;
  concurrency: number;
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
  retryable: boolean;
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

type DownloadEnginePort = Pick<HttpDownloadEngine, "probe" | "download" | "close">;

interface DownloadTaskState {
  resourceId: string;
  status: DownloadRuntimeStatus;
  phase: DownloadRuntimePhase;
  sourceUrl: string;
  sourceName: string | null;
  origin: ChatFileOrigin;
  sourceContext: Record<string, string | number | boolean | null>;
  proxyConsumer?: ProxyConsumer;
  owner: ShellRunOwner | null;
  requestedKind: ChatFileKind | null;
  concurrency: number;
  mimeType: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  checkpoint: HttpDownloadCheckpoint | null;
  file: ChatFileRecord | null;
  error: string | null;
  retryable: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  abortController: AbortController;
  tempPath: string;
  completedPath: string;
  completion: Promise<void>;
  notifyOnSettled: boolean;
}

export class DownloadRuntime {
  private readonly tasks = new Map<string, DownloadTaskState>();
  private readonly tmpReady: Promise<void>;
  private readonly engine: DownloadEnginePort;
  private eventHandler: DownloadRuntimeEventHandler | null;
  private closed = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly dataDir: string,
    private readonly chatFileStore: ChatFileStore,
    options?: {
      onEvent?: DownloadRuntimeEventHandler | null;
      engine?: DownloadEnginePort;
      allowPrivateHosts?: boolean;
    }
  ) {
    this.eventHandler = options?.onEvent ?? null;
    this.engine = options?.engine ?? createHttpDownloadEngine({
      allowPrivateHosts: options?.allowPrivateHosts ?? false,
      allowPrivateProxyHosts: true,
      maxConcurrency: MAX_DOWNLOAD_CONCURRENCY,
      userAgent: `${config.appName}/download-runtime`
    });
    this.tmpReady = this.cleanupStaleTempFiles();
  }

  setEventHandler(handler: DownloadRuntimeEventHandler | null): void {
    this.eventHandler = handler;
  }

  async start(input: DownloadStartInput): Promise<DownloadRuntimeSnapshot> {
    this.assertOpen();
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
      phase: "queued",
      sourceUrl,
      sourceName: normalizeOptionalString(input.sourceName) ?? inferFilenameFromUrl(sourceUrl),
      origin: input.origin,
      sourceContext: input.sourceContext ?? {},
      ...(input.proxyConsumer ? { proxyConsumer: input.proxyConsumer } : {}),
      owner: input.owner ?? null,
      requestedKind: input.kind ?? null,
      concurrency: normalizeConcurrency(input.concurrency),
      mimeType: null,
      downloadedBytes: 0,
      totalBytes: null,
      checkpoint: null,
      file: null,
      error: null,
      retryable: false,
      createdAtMs: now,
      updatedAtMs: now,
      abortController: new AbortController(),
      tempPath: join(tempDir, `${resourceId}.part`),
      completedPath: join(tempDir, `${resourceId}.complete`),
      completion: Promise.resolve(),
      notifyOnSettled: false
    };
    this.tasks.set(resourceId, state);
    state.completion = this.runDownload(state);

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

  async pause(resourceId: string): Promise<DownloadRuntimeSnapshot | null> {
    const state = this.tasks.get(resourceId);
    if (!state) return null;
    if (state.status !== "running") return this.snapshot(state, false);
    state.status = "paused";
    state.error = null;
    state.retryable = true;
    state.updatedAtMs = Date.now();
    state.abortController.abort(new Error("download paused"));
    return this.snapshot(state, false);
  }

  async resume(resourceId: string): Promise<DownloadRuntimeSnapshot | null> {
    this.assertOpen();
    const state = this.tasks.get(resourceId);
    if (!state) return null;
    if (state.status !== "paused" && !(state.status === "failed" && state.retryable)) {
      return this.snapshot(state, false);
    }
    await state.completion.catch(() => undefined);
    state.status = "running";
    state.phase = "queued";
    state.error = null;
    state.retryable = false;
    state.updatedAtMs = Date.now();
    state.abortController = new AbortController();
    state.completion = this.runDownload(state);
    return this.snapshot(state, false);
  }

  async cancel(resourceId: string): Promise<DownloadRuntimeSnapshot | null> {
    const state = this.tasks.get(resourceId);
    if (!state) return null;
    if (state.status === "running" || state.status === "paused" || state.status === "failed") {
      state.status = "cancelled";
      state.error = "download cancelled";
      state.retryable = false;
      state.updatedAtMs = Date.now();
      state.abortController.abort(new Error("download cancelled"));
      await this.cleanupTaskFiles(state);
    }
    return this.snapshot(state, false);
  }

  async remove(resourceId: string): Promise<boolean> {
    const state = this.tasks.get(resourceId);
    if (!state) return false;
    if (state.status === "running") {
      throw new Error("running download must be cancelled before removal");
    }
    await this.cleanupTaskFiles(state);
    this.tasks.delete(resourceId);
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = Array.from(this.tasks.values()).filter((state) => state.status === "running");
    for (const state of active) {
      state.status = "paused";
      state.retryable = true;
      state.updatedAtMs = Date.now();
      state.abortController.abort(new Error("download runtime closed"));
    }
    await Promise.allSettled(active.map((state) => state.completion));
    await this.engine.close();
  }

  private async runDownload(state: DownloadTaskState): Promise<void> {
    try {
      if (!await pathExists(state.completedPath)) {
        const proxy = this.resolveProxy(state);
        state.phase = "probing";
        state.updatedAtMs = Date.now();
        const probe = await this.engine.probe({
          url: state.sourceUrl,
          signal: state.abortController.signal,
          ...(proxy ? { proxy } : {})
        });
        state.totalBytes = probe.totalBytes;
        if (probe.totalBytes != null && probe.totalBytes > this.config.chatFiles.maxUploadBytes) {
          throw new Error("download exceeds chatFiles.maxUploadBytes");
        }
        const result = await this.engine.download({
          url: state.sourceUrl,
          destinationPath: state.completedPath,
          tempPath: state.tempPath,
          concurrency: state.concurrency,
          checkpoint: state.checkpoint,
          signal: state.abortController.signal,
          ...(proxy ? { proxy } : {}),
          onEvent: async (event) => this.handleEngineEvent(state, event)
        });
        state.downloadedBytes = result.totalBytes;
        state.totalBytes = result.totalBytes;
        state.updatedAtMs = Date.now();
      }
      this.throwIfInterrupted(state);
      state.phase = "importing";
      state.updatedAtMs = Date.now();
      const file = await this.chatFileStore.importFileFromPath({
        sourcePath: state.completedPath,
        origin: state.origin,
        sourceContext: {
          source_url: state.sourceUrl,
          ...state.sourceContext
        },
        ...(state.sourceName ? { sourceName: state.sourceName } : {}),
        ...(state.mimeType ? { mimeType: state.mimeType } : {}),
        ...(state.requestedKind ? { kind: state.requestedKind } : {})
      });
      if (state.status !== "running") {
        await this.chatFileStore.deleteFile(file.fileId).catch((cleanupError) => {
          this.logger.warn({ cleanupError, fileId: file.fileId, resourceId: state.resourceId }, "download_runtime_cancel_import_cleanup_failed");
        });
        throw new DownloadInterruptedError();
      }
      state.file = file;
      state.status = "completed";
      state.retryable = false;
      state.updatedAtMs = Date.now();
      await this.cleanupTaskFiles(state);
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
      if (state.status === "paused" || state.status === "cancelled" || error instanceof DownloadInterruptedError) {
        return;
      }
      state.status = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      state.retryable = readRetryable(error);
      state.updatedAtMs = Date.now();
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

  private async handleEngineEvent(state: DownloadTaskState, event: HttpDownloadEvent): Promise<void> {
    if (event.type === "phase") {
      state.phase = event.phase;
    } else if (event.type === "progress") {
      state.downloadedBytes = event.downloadedBytes;
      state.totalBytes = event.totalBytes;
      if (event.totalBytes != null && event.totalBytes > this.config.chatFiles.maxUploadBytes) {
        throw new Error("download exceeds chatFiles.maxUploadBytes");
      }
      if (event.downloadedBytes > this.config.chatFiles.maxUploadBytes) {
        throw new Error("download exceeds chatFiles.maxUploadBytes");
      }
    } else if (event.type === "checkpoint") {
      state.checkpoint = event.checkpoint;
    } else if (event.type === "checkpoint-reset") {
      state.checkpoint = null;
    }
    state.updatedAtMs = Date.now();
  }

  private resolveProxy(state: DownloadTaskState): { url: string } | null {
    if (!state.proxyConsumer) return null;
    const proxies = resolveProxyUrls(this.config, state.proxyConsumer);
    const protocol = new URL(state.sourceUrl).protocol;
    const proxyUrl = protocol === "https:" ? proxies.https : proxies.http;
    if (!proxyUrl) return null;
    const proxyProtocol = new URL(proxyUrl).protocol;
    if (proxyProtocol !== "http:" && proxyProtocol !== "https:") {
      throw new Error("download engine only supports HTTP or HTTPS proxies");
    }
    return { url: proxyUrl };
  }

  private snapshot(state: DownloadTaskState, includeBackgroundFollowup: boolean): DownloadRuntimeSnapshot {
    const percent = state.totalBytes && state.totalBytes > 0
      ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 1000) / 10)
      : null;
    return {
      ok: true,
      resource_id: state.resourceId,
      status: state.status,
      phase: state.phase,
      source_url: state.sourceUrl,
      source_name: state.file?.sourceName ?? state.sourceName,
      origin: state.origin,
      concurrency: state.concurrency,
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
      retryable: state.retryable,
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

  private throwIfInterrupted(state: DownloadTaskState): void {
    if (state.status !== "running" || state.abortController.signal.aborted) {
      throw new DownloadInterruptedError();
    }
  }

  private cleanupSettledTasks(): void {
    const now = Date.now();
    const settled = Array.from(this.tasks.values())
      .filter((state) => state.status === "completed" || state.status === "failed" || state.status === "cancelled")
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    const keep = new Set(settled.slice(0, MAX_SETTLED_TASKS).map((state) => state.resourceId));
    for (const state of settled) {
      if (keep.has(state.resourceId) && now - state.updatedAtMs <= SETTLED_TASK_RETENTION_MS) {
        continue;
      }
      void this.cleanupTaskFiles(state);
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

  private async cleanupTaskFiles(state: DownloadTaskState): Promise<void> {
    await Promise.all([
      rm(state.tempPath, { force: true }),
      rm(state.completedPath, { force: true })
    ]).catch(() => undefined);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("download runtime is closed");
  }
}

class DownloadInterruptedError extends Error {
  constructor() {
    super("download interrupted");
  }
}

function validateHttpUrl(value: string): string {
  const normalized = String(value ?? "").trim();
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("download sourceUrl must be an absolute http or https URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("download sourceUrl must not contain credentials");
  }
  parsed.hash = "";
  return parsed.toString();
}

function normalizeWaitMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value == null || value < 0) {
    return DEFAULT_FOREGROUND_WAIT_MS;
  }
  return Math.min(60000, Math.floor(value));
}

function normalizeConcurrency(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value == null || value <= 0) return 4;
  return Math.min(MAX_DOWNLOAD_CONCURRENCY, value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized ? basename(normalized) : undefined;
}

function inferFilenameFromUrl(sourceUrl: string): string {
  const encoded = basename(new URL(sourceUrl).pathname);
  if (!encoded || encoded === "/") return "download.bin";
  try {
    return decodeURIComponent(encoded).trim() || "download.bin";
  } catch {
    return encoded;
  }
}

function readRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "retryable" in error && (error as { retryable?: unknown }).retryable);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
