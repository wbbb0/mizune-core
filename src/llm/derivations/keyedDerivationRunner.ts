import type { Logger } from "pino";

export interface KeyedDerivationRunnerOptions {
  name: string;
  maxConcurrency: () => number;
  run: (key: string) => Promise<void>;
  logger?: Pick<Logger, "debug" | "warn">;
}

export class KeyedDerivationRunner {
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly pending: string[] = [];

  constructor(private readonly options: KeyedDerivationRunnerOptions) {}

  enqueue(keys: string[], context?: Record<string, unknown>): void {
    const pendingKeys = uniqueKeys(keys);
    let enqueued = 0;
    for (const key of pendingKeys) {
      if (this.queued.has(key) || this.running.has(key)) {
        continue;
      }
      this.queued.add(key);
      this.pending.push(key);
      enqueued += 1;
    }
    if (enqueued > 0) {
      this.options.logger?.debug({
        runner: this.options.name,
        keyCount: enqueued,
        ...(context ? { context } : {})
      }, "keyed_derivation_enqueued");
    }
    this.pump();
  }

  hasPendingOrRunning(key: string): boolean {
    const normalized = normalizeKey(key);
    return Boolean(normalized) && (this.queued.has(normalized) || this.running.has(normalized));
  }

  async waitForCompletion(key: string, abortSignal?: AbortSignal): Promise<void> {
    const normalized = normalizeKey(key);
    if (abortSignal?.aborted) {
      throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Derivation wait aborted");
    }
    if (!normalized || !this.hasPendingOrRunning(normalized)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.removeWaiter(normalized, waiter);
        reject(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error("Derivation wait aborted"));
      };
      const waiter = () => {
        abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const listeners = this.waiters.get(normalized) ?? new Set<() => void>();
      listeners.add(waiter);
      this.waiters.set(normalized, listeners);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private pump(): void {
    const rawMaxConcurrency = Number(this.options.maxConcurrency());
    const maxConcurrency = Number.isFinite(rawMaxConcurrency)
      ? Math.max(1, Math.floor(rawMaxConcurrency))
      : 1;
    while (this.running.size < maxConcurrency) {
      const nextKey = this.pending.shift();
      if (!nextKey) {
        return;
      }
      this.queued.delete(nextKey);
      this.running.add(nextKey);
      void this.runOne(nextKey);
    }
  }

  private async runOne(key: string): Promise<void> {
    try {
      await this.options.run(key);
    } catch (error: unknown) {
      this.options.logger?.warn({
        runner: this.options.name,
        key,
        error: error instanceof Error ? error.message : String(error)
      }, "keyed_derivation_failed");
    } finally {
      this.running.delete(key);
      this.notifyWaiters(key);
      this.pump();
    }
  }

  private notifyWaiters(key: string): void {
    const listeners = this.waiters.get(key);
    if (!listeners) {
      return;
    }
    this.waiters.delete(key);
    for (const listener of listeners) {
      listener();
    }
  }

  private removeWaiter(key: string, waiter: () => void): void {
    const listeners = this.waiters.get(key);
    if (!listeners) {
      return;
    }
    listeners.delete(waiter);
    if (listeners.size === 0) {
      this.waiters.delete(key);
    }
  }
}

function uniqueKeys(keys: string[]): string[] {
  return Array.from(new Set(keys.map(normalizeKey).filter(Boolean)));
}

function normalizeKey(key: string): string {
  return String(key ?? "").trim();
}
