import type { Logger } from "pino";

export interface KeyedDerivationRunnerOptions {
  name: string;
  maxConcurrency: () => number;
  maxTasks?: number;
  run: (key: string, abortSignal: AbortSignal) => Promise<void>;
  logger?: Pick<Logger, "debug" | "warn">;
}

export interface DerivationLease {
  completion: Promise<void>;
  completed: ReadonlyMap<string, Promise<void>>;
  release(reason?: unknown): void;
}

export class DerivationQueueFullError extends Error {
  readonly code = "DERIVATION_QUEUE_FULL";
  constructor(readonly maxTasks: number) {
    super(`派生任务容量已满（最多 ${maxTasks} 项）`);
    this.name = "DerivationQueueFullError";
  }
}

type Entry = {
  key: string;
  controller: AbortController;
  owners: Map<symbol, () => void>;
  done: Promise<void>;
  finish: () => void;
};

/** 每个等待者拥有可注销通知的独立租约；实际执行槽直到底层任务退出才释放。 */
export class KeyedDerivationRunner {
  private readonly entries = new Map<string, Entry>();
  private readonly pending: Entry[] = [];
  private readonly running = new Set<Entry>();
  private readonly leases = new Set<DerivationLease>();
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: KeyedDerivationRunnerOptions) {}

  hasTask(key: string): boolean { return this.entries.has(key); }

  acquire(keys: string[], options?: { abortSignal?: AbortSignal; context?: Record<string, unknown> }): DerivationLease {
    options?.abortSignal?.throwIfAborted();
    if (this.closePromise) throw new Error("派生任务执行器已关闭");
    const wanted = Array.from(new Set(keys.map(key => String(key ?? "").trim()).filter(Boolean)));
    const newKeys = wanted.filter(key => !this.entries.has(key));
    const configured = this.options.maxTasks ?? 256;
    const maxTasks = Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 256;
    if (this.entries.size + newKeys.length > maxTasks || this.leases.size >= 1024) throw new DerivationQueueFullError(maxTasks);
    const acquired = wanted.map(key => {
      let entry = this.entries.get(key);
      if (!entry) {
        let finish!: () => void;
        const done = new Promise<void>(resolve => { finish = resolve; });
        entry = { key, controller: new AbortController(), owners: new Map(), done, finish };
        this.entries.set(key, entry);
        this.pending.push(entry);
      }
      return entry;
    });
    const owner = Symbol("derivation-owner");
    const completed = new Map<string, Promise<void>>();
    const rejectItems: Array<(reason: unknown) => void> = [];
    let settled = false;
    let remaining = acquired.length;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const detach = () => {
      options?.abortSignal?.removeEventListener("abort", onAbort);
      this.leases.delete(lease);
      for (const entry of acquired) {
        entry.owners.delete(owner);
        if (entry.owners.size > 0 || this.entries.get(entry.key) !== entry) continue;
        this.entries.delete(entry.key);
        entry.controller.abort(new Error("派生任务已没有所有者"));
        const index = this.pending.indexOf(entry);
        if (index >= 0) {
          this.pending.splice(index, 1);
          entry.finish();
        }
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      detach();
      resolve();
    };
    const lease: DerivationLease = {
      completion, completed,
      release: (reason = new Error("派生任务租约已释放")) => {
        if (settled) return;
        settled = true;
        detach();
        for (const rejectItem of rejectItems) rejectItem(reason);
        reject(reason);
      }
    };
    const onAbort = () => lease.release(options?.abortSignal?.reason);
    for (const entry of acquired) {
      let resolveItem!: () => void;
      const item = new Promise<void>((yes, no) => { resolveItem = yes; rejectItems.push(no); });
      void item.catch(() => undefined);
      completed.set(entry.key, item);
      // 通知可从 entry 中真正删除；不把 caller 的闭包挂到共享 done Promise。
      entry.owners.set(owner, () => { resolveItem(); remaining--; if (remaining === 0) finish(); });
    }
    this.leases.add(lease);
    options?.abortSignal?.addEventListener("abort", onAbort, { once: true });
    void completion.catch(() => undefined);
    if (options?.abortSignal?.aborted) onAbort();
    else if (remaining === 0) finish();
    if (newKeys.length > 0) this.options.logger?.debug({ runner: this.options.name, keyCount: newKeys.length, ...options?.context }, "keyed_derivation_enqueued");
    this.pump();
    return lease;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      // 先赋值关闭状态，防止取消回调重入时重新准入。
      let resolve!: () => void;
      this.closePromise = new Promise<void>(yes => { resolve = yes; });
      for (const lease of [...this.leases]) lease.release(new Error("派生任务执行器已关闭"));
      void Promise.all([...this.running].map(entry => entry.done)).then(() => resolve());
    }
    return this.closePromise;
  }

  private pump(): void {
    const requested = Number(this.options.maxConcurrency());
    const maxConcurrency = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
    while (this.running.size < maxConcurrency && this.pending.length > 0) {
      const entry = this.pending.shift()!;
      if (entry.controller.signal.aborted || this.entries.get(entry.key) !== entry) continue;
      this.running.add(entry);
      void this.runOne(entry);
    }
  }

  private async runOne(entry: Entry): Promise<void> {
    try {
      await this.options.run(entry.key, entry.controller.signal);
    } catch (error: unknown) {
      if (!entry.controller.signal.aborted) this.options.logger?.warn({ runner: this.options.name, key: entry.key, error: error instanceof Error ? error.message : String(error) }, "keyed_derivation_failed");
    } finally {
      this.running.delete(entry);
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      entry.finish();
      const notify = [...entry.owners.values()];
      entry.owners.clear();
      for (const listener of notify) listener();
      this.pump();
    }
  }
}
