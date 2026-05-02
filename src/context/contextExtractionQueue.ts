import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { ContextExtractionResult, ContextExtractionService, ContextExtractionTurn } from "./contextExtractionService.ts";

interface PendingExtractionBatch {
  sessionId: string;
  userId: string;
  firstQueuedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  turns: ContextExtractionTurn[];
}

const MAX_PENDING_TURNS_PER_SESSION = 20;

export interface ContextExtractionQueueObserver {
  onBatchProcessed?: (event: {
    sessionId: string;
    userId: string;
    turns: ContextExtractionTurn[];
    result: ContextExtractionResult;
  }) => void;
  onBatchFailed?: (event: {
    sessionId: string;
    userId: string;
    turns: ContextExtractionTurn[];
    error: unknown;
  }) => void;
}

export class ContextExtractionQueue {
  private readonly pending = new Map<string, PendingExtractionBatch>();
  private readonly runningSessions = new Set<string>();
  private stopped = false;

  constructor(
    private readonly config: AppConfig,
    private readonly service: Pick<ContextExtractionService, "processTurns">,
    private readonly logger: Logger,
    private readonly observer: ContextExtractionQueueObserver = {}
  ) { }

  enqueueTurn(turn: ContextExtractionTurn): void {
    if (this.stopped || !this.config.context.extraction.enabled) {
      return;
    }
    const conversationText = turn.userMessages
      .map((message) => message.text.trim())
      .filter(Boolean)
      .join("\n");
    if (!conversationText) {
      return;
    }

    const queueKey = buildQueueKey(turn.sessionId, turn.userId);
    const pending = this.pending.get(queueKey) ?? {
      sessionId: turn.sessionId,
      userId: turn.userId,
      firstQueuedAt: Date.now(),
      timer: null,
      turns: []
    };
    pending.turns.push(turn);
    if (pending.turns.length > MAX_PENDING_TURNS_PER_SESSION) {
      pending.turns.splice(0, pending.turns.length - MAX_PENDING_TURNS_PER_SESSION);
    }
    this.pending.set(queueKey, pending);

    if (pending.turns.length >= this.config.context.extraction.maxTurnsPerBatch) {
      this.schedule(queueKey, 0);
      return;
    }
    this.schedule(queueKey);
  }

  stop(): void {
    this.stopped = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    this.pending.clear();
  }

  private schedule(queueKey: string, delayOverrideMs?: number): void {
    const pending = this.pending.get(queueKey);
    if (!pending || this.runningSessions.has(queueKey)) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }

    const now = Date.now();
    const config = this.config.context.extraction;
    const dueAt = delayOverrideMs !== undefined
      ? now + delayOverrideMs
      : Math.min(now + config.debounceMs, pending.firstQueuedAt + config.maxDelayMs);
    const delayMs = Math.max(0, dueAt - now);
    pending.timer = setTimeout(() => {
      void this.flush(queueKey);
    }, delayMs);
    pending.timer.unref?.();
  }

  private async flush(queueKey: string): Promise<void> {
    const pending = this.pending.get(queueKey);
    if (!pending || this.runningSessions.has(queueKey)) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(queueKey);
    this.runningSessions.add(queueKey);
    const turns = pending.turns.slice(-this.config.context.extraction.maxTurnsPerBatch);
    try {
      if (turns.length > 0) {
        const result = await this.service.processTurns({
          sessionId: pending.sessionId,
          userId: pending.userId,
          turns
        });
        this.notifyProcessed(pending, turns, result);
      }
    } catch (error) {
      this.logger.warn({
        sessionId: pending.sessionId,
        userId: pending.userId,
        error: error instanceof Error ? error.message : String(error)
      }, "context_extraction_failed_open");
      this.notifyFailed(pending, turns, error);
    } finally {
      this.runningSessions.delete(queueKey);
      if (this.pending.has(queueKey) && !this.stopped) {
        this.schedule(queueKey);
      }
    }
  }

  private notifyProcessed(
    pending: PendingExtractionBatch,
    turns: ContextExtractionTurn[],
    result: ContextExtractionResult
  ): void {
    try {
      this.observer.onBatchProcessed?.({
        sessionId: pending.sessionId,
        userId: pending.userId,
        turns,
        result
      });
    } catch (error) {
      this.logger.warn({
        sessionId: pending.sessionId,
        userId: pending.userId,
        error: error instanceof Error ? error.message : String(error)
      }, "context_extraction_observer_failed_open");
    }
  }

  private notifyFailed(
    pending: PendingExtractionBatch,
    turns: ContextExtractionTurn[],
    error: unknown
  ): void {
    try {
      this.observer.onBatchFailed?.({
        sessionId: pending.sessionId,
        userId: pending.userId,
        turns,
        error
      });
    } catch (observerError) {
      this.logger.warn({
        sessionId: pending.sessionId,
        userId: pending.userId,
        error: observerError instanceof Error ? observerError.message : String(observerError)
      }, "context_extraction_observer_failed_open");
    }
  }
}

function buildQueueKey(sessionId: string, userId: string): string {
  return `${sessionId}\u0000${userId}`;
}
