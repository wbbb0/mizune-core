import type { Logger } from "pino";
import type { ContextExtractionQueue } from "./contextExtractionQueue.ts";
import type { ContextStore } from "./contextStore.ts";

export class ContextSessionCleanupService {
  constructor(
    private readonly contextStore: Pick<ContextStore, "deleteSessionScopedItems">,
    private readonly contextExtractionQueue: Pick<ContextExtractionQueue, "cancelSession"> | null,
    private readonly logger: Pick<Logger, "info">
  ) { }

  cleanupDeletedSession(input: { sessionId: string }): {
    deletedContextItemCount: number;
    cancelledExtractionBatchCount: number;
    cancelledExtractionTurnCount: number;
  } {
    const cancelled = this.contextExtractionQueue?.cancelSession({ sessionId: input.sessionId }) ?? {
      cancelledBatchCount: 0,
      cancelledTurnCount: 0
    };
    const deleted = this.contextStore.deleteSessionScopedItems(input.sessionId);
    const result = {
      deletedContextItemCount: deleted.deletedCount,
      cancelledExtractionBatchCount: cancelled.cancelledBatchCount,
      cancelledExtractionTurnCount: cancelled.cancelledTurnCount
    };
    if (result.deletedContextItemCount > 0 || result.cancelledExtractionTurnCount > 0) {
      this.logger.info({ sessionId: input.sessionId, ...result }, "context_deleted_session_cleanup_completed");
    }
    return result;
  }
}
