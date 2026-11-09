import { DerivationQueueFullError, KeyedDerivationRunner } from "#llm/derivations/keyedDerivationRunner.ts";
import type { ChatFileStore } from "../chatFileStore.ts";
import type { MediaLocator, MediaResolution, MediaScope, MediaSourceInput, MediaSourceRepository } from "./types.ts";

interface Dependencies {
  sources: MediaSourceRepository;
  files: Pick<ChatFileStore, "importRemoteSource" | "getFile" | "isFileAvailable" | "deleteFile">;
  refresh: (scope: MediaScope, locator: MediaLocator, signal?: AbortSignal) => Promise<string | null>;
  onResolved?: (scope: MediaScope, resolution: MediaResolution, signal: AbortSignal) => void | Promise<void>;
  now?: () => number;
  operationTimeoutMs?: number;
}

type Flight = { scope: MediaScope; ref: string; result: MediaResolution | null; error?: unknown };
class MediaImportTimeoutError extends Error {}

/** 入口、引用工具及 prompt recovery 共用有界任务和来源版本，不调用模型。 */
export class MediaImportService {
  private readonly flights = new Map<string, Flight>();
  private readonly runner: KeyedDerivationRunner;
  private readonly owners = new Set<AbortController>();
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly dependencies: Dependencies) {
    this.runner = new KeyedDerivationRunner({ name: "media_import", maxConcurrency: () => 4, maxTasks: 256,
      run: async (key, signal) => {
        const flight = this.flights.get(key)!;
        try { flight.result = await this.run(flight.scope, flight.ref, signal); }
        catch (error) { flight.error = error; }
        finally { if (this.flights.get(key) === flight) this.flights.delete(key); }
      }
    });
  }

  async import(scope: MediaScope, input: MediaSourceInput, signal?: AbortSignal): Promise<{ ref: string; resolution: MediaResolution | null }> {
    let registeredRef: string | undefined;
    try {
      return await this.withOwner(signal, async ownerSignal => {
        const record = await this.dependencies.sources.register(scope, input, ownerSignal);
        registeredRef = record.id;
        return { ref: record.id, resolution: await this.resolveOwned(scope, record.id, ownerSignal) };
      });
    } catch (error) {
      if ((error instanceof MediaImportTimeoutError || error instanceof DerivationQueueFullError) && registeredRef) return { ref: registeredRef, resolution: null };
      throw error;
    }
  }

  async resolve(scope: MediaScope, ref: string, signal?: AbortSignal): Promise<MediaResolution | null> {
    try { return await this.withOwner(signal, ownerSignal => this.resolveOwned(scope, ref, ownerSignal)); }
    catch (error) { if (error instanceof MediaImportTimeoutError) return null; throw error; }
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      let finish!: () => void;
      this.stopPromise = new Promise<void>(resolve => { finish = resolve; });
      for (const owner of this.owners) owner.abort(new Error("媒体导入服务已关闭"));
      void this.runner.close().then(finish);
    }
    return this.stopPromise;
  }

  private async withOwner<T>(callerSignal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    callerSignal?.throwIfAborted();
    if (this.stopPromise) throw new Error("媒体导入服务已关闭");
    if (this.owners.size >= 1024) throw new DerivationQueueFullError(256);
    const controller = new AbortController();
    this.owners.add(controller);
    const onAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new MediaImportTimeoutError("媒体导入总期限已到")), this.dependencies.operationTimeoutMs ?? 30_000);
    let abort!: () => void;
    try {
      return await new Promise<T>((resolve, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        void operation(controller.signal).then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
      this.owners.delete(controller);
      callerSignal?.removeEventListener("abort", onAbort);
      controller.signal.removeEventListener("abort", abort);
    }
  }

  private async resolveOwned(scope: MediaScope, ref: string, signal: AbortSignal): Promise<MediaResolution | null> {
    signal.throwIfAborted();
    // 即使另一个调用者已经取得 flight，也独立检查本调用者的 scope。
    if (!await this.dependencies.sources.get(scope, ref)) return null;
    signal.throwIfAborted();
    const key = JSON.stringify([scope.connectionId, scope.sessionId, ref]);
    let flight = this.flights.get(key);
    if (!flight || !this.runner.hasTask(key)) {
      flight = { scope, ref, result: null };
      this.flights.set(key, flight);
    }
    let lease;
    try { lease = this.runner.acquire([key], { abortSignal: signal }); }
    catch (error) { if (!this.runner.hasTask(key) && this.flights.get(key) === flight) this.flights.delete(key); throw error; }
    try {
      await lease.completion;
      signal.throwIfAborted();
      if (flight.error !== undefined) throw flight.error;
      return flight.result;
    } finally {
      lease.release();
      if (!this.runner.hasTask(key) && this.flights.get(key) === flight) this.flights.delete(key);
    }
  }

  private async run(scope: MediaScope, ref: string, signal: AbortSignal): Promise<MediaResolution | null> {
    signal.throwIfAborted();
    const record = await this.dependencies.sources.get(scope, ref);
    signal.throwIfAborted();
    if (!record) return null;
    if (record.assetId && await this.dependencies.files.isFileAvailable(record.assetId)) {
      signal.throwIfAborted();
      const file = await this.dependencies.files.getFile(record.assetId);
      signal.throwIfAborted();
      if (file) {
        const resolution = { ref, kind: record.input.kind, file };
        await this.dependencies.onResolved?.(scope, resolution, signal);
        signal.throwIfAborted();
        return resolution;
      }
    }
    const now = (this.dependencies.now ?? Date.now)();
    if (record.nextRetryAt > now) return null;
    const tryImport = () => this.dependencies.files.importRemoteSource({
      source: record.input.source, kind: record.input.kind === "emoji" ? "image" : record.input.kind,
      origin: "chat_message", signal, ...(record.input.sourceName ? { sourceName: record.input.sourceName } : {}),
      ...(record.input.mimeType ? { mimeType: record.input.mimeType } : {}),
      sourceContext: { ...record.input.sourceContext, mediaKind: record.input.kind, media_source_ref: ref }
    });
    let file;
    try {
      if (record.failures && record.input.locator) {
        const fresh = await this.dependencies.refresh(scope, record.input.locator, signal);
        signal.throwIfAborted();
        if (fresh) record.input.source = fresh;
      }
      try { file = await tryImport(); }
      catch (error) {
        signal.throwIfAborted();
        if (!record.input.locator || record.failures) throw error;
        const fresh = await this.dependencies.refresh(scope, record.input.locator, signal);
        signal.throwIfAborted();
        if (!fresh || fresh === record.input.source) throw error;
        record.input.source = fresh;
        file = await tryImport();
      }
    } catch {
      signal.throwIfAborted();
      record.assetId = null;
      record.failures += 1;
      record.nextRetryAt = (this.dependencies.now ?? Date.now)() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(record.failures - 1, 5));
      await this.dependencies.sources.save(record, signal);
      return null;
    }
    let transferred = false;
    try {
      signal.throwIfAborted();
      record.assetId = file.fileId;
      record.failures = 0;
      record.nextRetryAt = 0;
      if (!await this.dependencies.sources.save(record, signal)) return null;
      transferred = true;
      signal.throwIfAborted();
      const current = await this.dependencies.sources.get(scope, ref);
      signal.throwIfAborted();
      if (!current || current.version !== record.version) return null;
      const resolution = { ref, kind: record.input.kind, file };
      await this.dependencies.onResolved?.(scope, resolution, signal);
      signal.throwIfAborted();
      return resolution;
    } finally {
      // 来源成功接管前，新文件没有任何公开句柄，取消/版本冲突时回收。
      if (!transferred) await this.dependencies.files.deleteFile(file.fileId);
    }
  }
}
