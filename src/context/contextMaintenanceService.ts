import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { ContextStore } from "./contextStore.ts";
import type { ContextRetrievalService } from "./contextRetrievalService.ts";

export class ContextMaintenanceService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly contextStore: Pick<
      ContextStore,
      "listUserIdsWithSearchChunks" | "compactUserSearchChunks" | "sweepUserSearchChunks" | "sweepDeletedItems"
    >,
    private readonly contextRetrievalService: Pick<ContextRetrievalService, "rebuildUserIndexes">,
    private readonly logger: Logger
  ) { }

  start(): void {
    if (this.timer) {
      return;
    }
    const intervalMs = this.config.context.retention.maintenanceIntervalMs;
    this.timer = setInterval(() => {
      void this.runOnce("interval");
    }, intervalMs);
    this.timer.unref?.();
    void this.runOnce("startup");
    this.logger.info({ intervalMs }, "context_maintenance_started");
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
    this.logger.info("context_maintenance_stopped");
  }

  async runOnce(reason: "startup" | "interval" | "manual" = "manual"): Promise<{
    compactedCount: number;
    sweptChunkCount: number;
    sweptDeletedCount: number;
    embeddedCount: number;
    indexedCount: number;
    skippedEmbeddingCount: number;
  }> {
    if (this.running) {
      return {
        compactedCount: 0,
        sweptChunkCount: 0,
        sweptDeletedCount: 0,
        embeddedCount: 0,
        indexedCount: 0,
        skippedEmbeddingCount: 0
      };
    }
    this.running = true;
    try {
      const retention = this.config.context.retention;
      const now = Date.now();
      let compactedCount = 0;
      let sweptChunkCount = 0;
      for (const userId of this.contextStore.listUserIdsWithSearchChunks()) {
        const compacted = this.contextStore.compactUserSearchChunks({
          userId,
          olderThanMs: retention.summaryAfterDays * 24 * 60 * 60 * 1000,
          maxSourceChunks: 20,
          now
        });
        compactedCount += compacted.compactedCount;
        const swept = this.contextStore.sweepUserSearchChunks({
          userId,
          maxChunks: retention.maxUserSearchChunks,
          maxAgeMs: retention.maxSearchChunkAgeDays * 24 * 60 * 60 * 1000,
          now
        });
        sweptChunkCount += swept.deletedCount;
      }
      const sweptDeleted = this.contextStore.sweepDeletedItems({
        deletedBeforeMs: retention.deletedRetentionDays * 24 * 60 * 60 * 1000,
        now
      });
      const rebuild = this.config.context.indexing.rebuildOnMaintenance
        ? await this.contextRetrievalService.rebuildUserIndexes({
            embeddingBatchSize: this.config.context.indexing.maintenanceEmbeddingBatchSize
          })
        : {
            embeddedCount: 0,
            indexedCount: 0,
            skippedCount: 0,
            errors: []
          };
      const result = {
        compactedCount,
        sweptChunkCount,
        sweptDeletedCount: sweptDeleted.deletedCount,
        embeddedCount: rebuild.embeddedCount,
        indexedCount: rebuild.indexedCount,
        skippedEmbeddingCount: rebuild.skippedCount
      };
      if (compactedCount > 0 || sweptChunkCount > 0 || sweptDeleted.deletedCount > 0 || rebuild.embeddedCount > 0 || rebuild.indexedCount > 0 || rebuild.errors.length > 0) {
        this.logger.info({ reason, ...result, errors: rebuild.errors }, "context_maintenance_completed");
      }
      return result;
    } catch (error) {
      this.logger.warn({
        reason,
        error: error instanceof Error ? error.message : String(error)
      }, "context_maintenance_failed_open");
      return {
        compactedCount: 0,
        sweptChunkCount: 0,
        sweptDeletedCount: 0,
        embeddedCount: 0,
        indexedCount: 0,
        skippedEmbeddingCount: 0
      };
    } finally {
      this.running = false;
    }
  }
}
