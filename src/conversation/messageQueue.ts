import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";

function computeTypingDelayMs(text: string, cfg: AppConfig["conversation"]["outbound"]): number {
  return Math.min(cfg.baseDelayMs + text.length * cfg.charDelayMs, cfg.maxDelayMs);
}

function applyRandomFactor(delayMs: number, cfg: AppConfig["conversation"]["outbound"]): number {
  const factor = cfg.randomFactorMin < cfg.randomFactorMax
    ? cfg.randomFactorMin + Math.random() * (cfg.randomFactorMax - cfg.randomFactorMin)
    : 1;
  return Math.round(delayMs * factor);
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    };

    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class MessageQueue {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly logger: Logger,
    private readonly config: AppConfig
  ) {}

  enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.queues.get(sessionId) === next) {
          this.queues.delete(sessionId);
        }
      });

    this.queues.set(sessionId, next);
    return next;
  }

  enqueueDetached(sessionId: string, task: () => Promise<void>): void {
    void this.enqueue(sessionId, task).catch((error: unknown) => {
      this.logger.warn(
        {
          sessionId,
          err: error
        },
        "message_queue_task_failed"
      );
    });
  }

  getDrainPromise(sessionId: string): Promise<void> | null {
    return this.queues.get(sessionId) ?? null;
  }

  async enqueueText(params: {
    sessionId: string;
    text: string;
    send: () => Promise<void>;
    abortSignal?: AbortSignal;
    abortSignals?: AbortSignal[];
  }): Promise<void> {
    await this.enqueue(params.sessionId, async () => {
      const effectiveAbortSignal = combineAbortSignals([
        params.abortSignal,
        ...(params.abortSignals ?? [])
      ]);
      if (effectiveAbortSignal?.aborted) {
        this.logger.debug({ sessionId: params.sessionId }, "outbound_send_skipped_before_delay");
        return;
      }

      const cfg = this.config.conversation.outbound;
      const baseDelayMs = cfg.instantReply ? 0 : computeTypingDelayMs(params.text, cfg);
      const randomizedDelayMs = cfg.instantReply ? 0 : applyRandomFactor(baseDelayMs, cfg);
      const previousSentAt = this.lastSentAt.get(params.sessionId);
      const targetAt = (previousSentAt ?? Date.now()) + randomizedDelayMs;
      const waitMs = Math.max(0, targetAt - Date.now());

      this.logger.debug(
        {
          sessionId: params.sessionId,
          baseDelayMs,
          randomizedDelayMs,
          previousSentAt: previousSentAt ?? null,
          waitMs
        },
        "outbound_delay_scheduled"
      );

      await sleep(waitMs, effectiveAbortSignal);
      if (effectiveAbortSignal?.aborted) {
        this.logger.debug({ sessionId: params.sessionId }, "outbound_send_skipped_after_delay");
        return;
      }
      await params.send();
      this.lastSentAt.set(params.sessionId, Date.now());
    });
  }

  enqueueTextDetached(params: {
    sessionId: string;
    text: string;
    send: () => Promise<void>;
    abortSignal?: AbortSignal;
    abortSignals?: AbortSignal[];
  }): void {
    void this.enqueueText(params).catch((error: unknown) => {
      this.logger.warn(
        {
          sessionId: params.sessionId,
          err: error
        },
        "message_queue_task_failed"
      );
    });
  }
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const filtered = signals.filter((signal): signal is AbortSignal => signal != null);
  if (filtered.length === 0) {
    return undefined;
  }
  if (filtered.length === 1) {
    return filtered[0];
  }
  return AbortSignal.any(filtered);
}
