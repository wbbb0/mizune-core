import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { annotateStructuredMediaReferences, extractStructuredMediaIds } from "#images/imageReferences.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import { buildHistorySummaryPrompt } from "#llm/prompts/history-summary.prompt.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import type { SessionCompressionAccess } from "#conversation/session/sessionCapabilities.ts";
import type { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";
import type { ToolObservationSummary } from "#conversation/session/toolObservation.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import {
  DerivedObservationReader,
  imageCaptionMapFromDerivedObservations
} from "#llm/derivations/derivedObservationReader.ts";

interface HistoryCompressionOptions {
  triggerReason?: string | undefined;
}

interface CompressionLogContext {
  triggerReason: string;
  triggerKind: "tokens" | "message_count";
  expectedHistoryRevision: number;
  triggerTokens?: number | undefined;
  retainTokens?: number | undefined;
  reportedInputTokens?: number | undefined;
  estimatedTotalTokens?: number | undefined;
  triggerMessageCount?: number | undefined;
  retainMessageCount?: number | undefined;
}

export class HistoryCompressor {
  private readonly inFlightSessions = new Set<string>();
  private readonly skippedTokenChecks = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly sessionManager: SessionCompressionAccess,
    private readonly mediaCaptionService: MediaCaptionService,
    private readonly logger: Logger,
    private readonly chatFileStore?: Pick<ChatFileStore, "getMany">
  ) {}

  async maybeCompress(sessionId: string, options?: HistoryCompressionOptions): Promise<boolean> {
    return this.compressByTokens(sessionId, {
      triggerTokens: this.config.conversation.historyCompression.triggerTokens,
      retainTokens: this.config.conversation.historyCompression.retainTokens,
      expectedHistoryRevision: this.sessionManager.getHistoryRevision(sessionId),
      triggerReason: options?.triggerReason ?? "maybe_compress"
    });
  }

  async forceCompact(sessionId: string, retainMessageCount?: number, options?: HistoryCompressionOptions): Promise<boolean> {
    const safeRetainCount = retainMessageCount == null
      ? this.config.conversation.historyCompression.retainMessageCount
      : Math.max(0, retainMessageCount);
    return this.compressByMessageCount(sessionId, {
      triggerMessageCount: 0,
      retainMessageCount: safeRetainCount,
      expectedHistoryRevision: this.sessionManager.getHistoryRevision(sessionId),
      force: true,
      triggerReason: options?.triggerReason ?? "force_compact"
    });
  }

  async compactOldHistoryKeepingRecent(sessionId: string, recentMessageCountToKeep: number, options?: HistoryCompressionOptions): Promise<boolean> {
    const safeKeepCount = Math.max(0, recentMessageCountToKeep);
    return this.compressByMessageCount(sessionId, {
      triggerMessageCount: safeKeepCount,
      retainMessageCount: safeKeepCount,
      expectedHistoryRevision: this.sessionManager.getHistoryRevision(sessionId),
      force: true,
      triggerReason: options?.triggerReason ?? "compact_old_history_keep_recent"
    });
  }

  private async compressByTokens(
    sessionId: string,
    options: {
      triggerTokens: number;
      retainTokens: number;
      expectedHistoryRevision: number;
      triggerReason: string;
    }
  ): Promise<boolean> {
    if (this.inFlightSessions.has(sessionId)) {
      return false;
    }
    if (!this.config.conversation.historyCompression.enabled) {
      return false;
    }
    if (
      !this.config.llm.enabled
      || !this.config.llm.summarizer.enabled
      || !this.llmClient.isConfigured(this.resolveModelRefs())
    ) {
      return false;
    }
    this.inFlightSessions.add(sessionId);
    try {
      // Use provider-reported input tokens from the last request as a more accurate
      // trigger signal when available, falling back to the heuristic estimate otherwise.
      const lastUsage = this.sessionManager.getLastLlmUsage(sessionId);
      const reportedInputTokens = lastUsage?.inputTokens ?? undefined;
      const skipKey = [
        options.expectedHistoryRevision,
        lastUsage?.capturedAt ?? "no_usage",
        options.triggerTokens,
        options.retainTokens
      ].join(":");
      if (this.skippedTokenChecks.get(sessionId) === skipKey) {
        return false;
      }
      const logContext: CompressionLogContext = {
        triggerReason: options.triggerReason,
        triggerKind: "tokens",
        expectedHistoryRevision: options.expectedHistoryRevision,
        triggerTokens: options.triggerTokens,
        retainTokens: options.retainTokens,
        reportedInputTokens
      };
      this.logger.debug({ sessionId, ...logContext }, "history_compression_evaluating");
      const snapshot = this.sessionManager.getHistoryForCompressionByTokens(
        sessionId,
        options.triggerTokens,
        options.retainTokens,
        reportedInputTokens
      );
      if (!snapshot) {
        this.skippedTokenChecks.set(sessionId, skipKey);
        this.logger.debug({ sessionId, ...logContext }, "history_compression_skipped_below_threshold");
        return false;
      }
      this.skippedTokenChecks.delete(sessionId);
      return await this.runCompression(sessionId, snapshot, options.expectedHistoryRevision, false, {
        ...logContext,
        estimatedTotalTokens: snapshot.estimatedTotalTokens
      });
    } finally {
      this.inFlightSessions.delete(sessionId);
    }
  }

  private async compressByMessageCount(
    sessionId: string,
    options: {
      triggerMessageCount: number;
      retainMessageCount: number;
      expectedHistoryRevision: number;
      force?: boolean;
      triggerReason: string;
    }
  ): Promise<boolean> {
    if (this.inFlightSessions.has(sessionId)) {
      return false;
    }

    if (!this.config.conversation.historyCompression.enabled) {
      return false;
    }

    if (
      !this.config.llm.enabled
      || !this.config.llm.summarizer.enabled
      || !this.llmClient.isConfigured(this.resolveModelRefs())
    ) {
      return false;
    }

    this.inFlightSessions.add(sessionId);
    try {
      const logContext: CompressionLogContext = {
        triggerReason: options.triggerReason,
        triggerKind: "message_count",
        expectedHistoryRevision: options.expectedHistoryRevision,
        triggerMessageCount: options.triggerMessageCount,
        retainMessageCount: options.retainMessageCount
      };
      this.logger.debug({ sessionId, ...logContext, force: options.force ?? false }, "history_compression_evaluating");
      const snapshot = this.sessionManager.getHistoryForCompression(
        sessionId,
        options.triggerMessageCount,
        options.retainMessageCount
      );
      if (!snapshot) {
        this.logger.debug({ sessionId, ...logContext, force: options.force ?? false }, "history_compression_skipped_below_threshold");
        return false;
      }
      return await this.runCompression(sessionId, snapshot, options.expectedHistoryRevision, options.force ?? false, logContext);
    } finally {
      this.inFlightSessions.delete(sessionId);
    }
  }

  private async runCompression(
    sessionId: string,
    snapshot: {
      historySummary: string | null;
      messagesToCompress: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
      retainedMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
      toolObservationsToCompress: ToolObservationSummary[];
      transcriptStartIndexToKeep: number;
    },
    expectedHistoryRevision: number,
    force: boolean,
    logContext: CompressionLogContext
  ): Promise<boolean> {
    const imageIds = Array.from(new Set(snapshot.messagesToCompress.flatMap((message) => extractStructuredMediaIds(message.content))));
    const fallbackCaptions = imageIds.length > 0
      ? await this.mediaCaptionService.ensureReady(imageIds, { reason: "history_compression" })
      : new Map<string, string>();
    const captions = await this.readCaptionMapFromDerivedObservations(imageIds, fallbackCaptions);
    const messagesToCompress = snapshot.messagesToCompress.map((message) => ({
      ...message,
      content: annotateStructuredMediaReferences(message.content, captions, { includeIds: false })
    }));

    this.logger.info(
      {
        sessionId,
        messagesToCompress: messagesToCompress.length,
        retainedMessages: snapshot.retainedMessages.length,
        captionCount: captions.size,
        force,
        ...logContext
      },
      "history_compression_started"
    );

    const summaryResult = await this.llmClient.generate({
      modelRefOverride: this.resolveModelRefs(),
      timeoutMsOverride: this.config.llm.summarizer.timeoutMs,
      enableThinkingOverride: this.config.llm.summarizer.enableThinking,
      skipDebugDump: true,
      messages: buildHistorySummaryPrompt({
        sessionId,
        existingSummary: snapshot.historySummary,
        messagesToCompress,
        toolObservationsToCompress: snapshot.toolObservationsToCompress
      })
    });
    const summary = summaryResult.text;

    const applied = this.sessionManager.applyCompressedHistoryIfHistoryRevisionMatches(
      sessionId,
      expectedHistoryRevision,
      {
        historySummary: summary,
        transcriptStartIndexToKeep: snapshot.transcriptStartIndexToKeep
      }
    );
    if (!applied) {
      this.logger.info(
        { sessionId, ...logContext },
        "history_compression_skipped_history_revision_mismatch"
      );
      return false;
    }

    this.logger.info(
      {
        sessionId,
        summaryLength: summary.length,
        retainedMessages: snapshot.retainedMessages.length,
        force,
        ...logContext
      },
      "history_compression_succeeded"
    );
    return true;
  }

  private resolveModelRefs(): string[] {
    return getModelRefsForRole(this.config, "summarizer");
  }

  private async readCaptionMapFromDerivedObservations(
    imageIds: string[],
    fallbackCaptions: Map<string, string>
  ): Promise<Map<string, string>> {
    if (imageIds.length === 0 || !this.chatFileStore) {
      return fallbackCaptions;
    }
    const observations = await new DerivedObservationReader({
      chatFileStore: this.chatFileStore
    }).read({ chatFileIds: imageIds });
    return imageCaptionMapFromDerivedObservations(observations);
  }
}
