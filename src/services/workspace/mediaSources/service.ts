import type { ChatFileStore } from "../chatFileStore.ts";
import type { MediaLocator, MediaResolution, MediaScope, MediaSourceInput, MediaSourceRepository } from "./types.ts";

interface Dependencies {
  sources: MediaSourceRepository;
  files: Pick<ChatFileStore, "importRemoteSource" | "getFile" | "isFileAvailable">;
  refresh: (scope: MediaScope, locator: MediaLocator, signal?: AbortSignal) => Promise<string | null>;
  onResolved?: (scope: MediaScope, resolution: MediaResolution) => void | Promise<void>;
  now?: () => number;
}

/** One cache/retry authority for ingress, reference tools and prompt recovery. Never calls models. */
export class MediaImportService {
  private readonly flights = new Map<string, Promise<MediaResolution | null>>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;
  constructor(private readonly dependencies: Dependencies) {}

  async import(scope: MediaScope, input: MediaSourceInput): Promise<{ ref: string; resolution: MediaResolution | null }> {
    const record = await this.dependencies.sources.register(scope, input);
    return { ref: record.id, resolution: await this.resolve(scope, record.id) };
  }

  async resolve(scope: MediaScope, ref: string, signal?: AbortSignal): Promise<MediaResolution | null> {
    signal?.throwIfAborted();
    // Check the caller's scope even when another caller already owns the flight.
    const record = await this.dependencies.sources.get(scope, ref);
    if (!record) return null;
    signal?.throwIfAborted();
    const key = `${scope.connectionId}:${scope.sessionId}:${ref}`;
    let flight = this.flights.get(key);
    if (!flight) {
      flight = this.run(scope, ref).finally(() => this.flights.delete(key));
      this.flights.set(key, flight);
    }
    const result = signal ? await new Promise<MediaResolution | null>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener("abort", abort, { once: true });
      flight!.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    }) : await flight;
    signal?.throwIfAborted();
    return result;
  }

  private async run(scope: MediaScope, ref: string): Promise<MediaResolution | null> {
    if (this.active >= 4) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active += 1;
    try {
      const record = await this.dependencies.sources.get(scope, ref);
      if (!record) return null;
      const now = (this.dependencies.now ?? Date.now)();
      if (record.assetId && await this.dependencies.files.isFileAvailable(record.assetId)) {
        const file = await this.dependencies.files.getFile(record.assetId);
        if (file) {
          const resolution = { ref, kind: record.input.kind, file };
          await this.dependencies.onResolved?.(scope, resolution);
          return resolution;
        }
      }
      if (record.nextRetryAt > now) return null;
      const operationSignal = AbortSignal.timeout(30_000);
      const tryImport = async () => this.dependencies.files.importRemoteSource({
        source: record.input.source, kind: record.input.kind === "emoji" ? "image" : record.input.kind,
        origin: "chat_message", signal: operationSignal, ...(record.input.sourceName ? { sourceName: record.input.sourceName } : {}),
        ...(record.input.mimeType ? { mimeType: record.input.mimeType } : {}),
        sourceContext: { ...record.input.sourceContext, mediaKind: record.input.kind, media_source_ref: ref }
      });
      let file;
      try {
        // A failed previous attempt may carry an expired platform URL. Refresh only through its bound locator.
        if (record.failures && record.input.locator) {
          const fresh = await this.dependencies.refresh(scope, record.input.locator, operationSignal);
          if (fresh) record.input.source = fresh;
        }
        try { file = await tryImport(); }
        catch (error) {
          if (!record.input.locator || record.failures) throw error;
          operationSignal.throwIfAborted();
          const fresh = await this.dependencies.refresh(scope, record.input.locator, operationSignal);
          if (!fresh || fresh === record.input.source) throw error;
          record.input.source = fresh;
          file = await tryImport();
        }
      } catch {
        record.assetId = null;
        record.failures += 1;
        record.nextRetryAt = (this.dependencies.now ?? Date.now)() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(record.failures - 1, 5));
        await this.dependencies.sources.save(record);
        return null;
      }
      record.assetId = file.fileId;
      record.failures = 0;
      record.nextRetryAt = 0;
      await this.dependencies.sources.save(record);
      const resolution = { ref, kind: record.input.kind, file };
      await this.dependencies.onResolved?.(scope, resolution);
      return resolution;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
