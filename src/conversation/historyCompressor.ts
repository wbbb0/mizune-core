import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { annotateStructuredMediaReferences, extractStructuredMediaIds } from "#images/imageReferences.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import { buildHistorySummaryPrompt } from "#llm/prompts/history-summary.prompt.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import type { SessionCompressionAccess } from "#conversation/session/sessionCapabilities.ts";
import type { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";

export class HistoryCompressor {
  private readonly inFlightSessions = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly sessionManager: SessionCompressionAccess,
    private readonly mediaCaptionService: MediaCaptionService,
    private readonly logger: Logger
  ) {}

  async maybeCompress(sessionId: string): Promise<boolean> {
    return this.compressByTokens(sessionId, {
      triggerTokens: this.config.conversation.historyCompression.triggerTokens,
      retainTokens: this.config.conversation.historyCompression.retainTokens,
      expectedHistoryRevision: this.sessionManager.getHistoryRevision(sessionId)
    });
  }

  async forceCompact(sessionId: string, retainMessageCount?: number): Promise<boolean> {
    const safeRetainCount = retainMessageCount == null
      ? this.config.conversation.historyCompression.retainMessageCount
      : Math.max(0, retainMessageCount);
    return this.compressByMessageCount(sessionId, {
      triggerMessageCount: 0,
      retainMessageCount: safeRetainCount,
      expectedHistoryRevision: this.sessionManager.getHistoryRevision(sessionId),
      force: true
    });
  }

  async compactOldHistoryKeepingRecent(sessionId: string, recentMessageCountToKeep: number): Promise<boolean> {
    const safeKeepCount = Math.max(0, recentMessageCountToKeep);
    return this.compressByMessageCount(sessionId, {
      triggerMessageCount: safeKeepCount,
      retainMessageCount: safeKeepCount,
      expectedHistoryRevision: this.sessionManager.getHistoryRevision(sessionId),
      force: true
    });
  }

  private async compressByTokens(
    sessionId: string,
    options: {
      triggerTokens: number;
      retainTokens: number;
      expectedHistoryRevision: number;
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
      const snapshot = this.sessionManager.getHistoryForCompressionByTokens(
        sessionId,
        options.triggerTokens,
        options.retainTokens,
        reportedInputTokens
      );
      if (!snapshot) {
        return false;
      }
      return await this.runCompression(sessionId, snapshot, options.expectedHistoryRevision, false);
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
      const snapshot = this.sessionManager.getHistoryForCompression(
        sessionId,
        options.triggerMessageCount,
        options.retainMessageCount
      );
      if (!snapshot) {
        return false;
      }
      return await this.runCompression(sessionId, snapshot, options.expectedHistoryRevision, options.force ?? false);
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
      transcriptStartIndexToKeep: number;
    },
    expectedHistoryRevision: number,
    force: boolean
  ): Promise<boolean> {
    const imageIds = Array.from(new Set(snapshot.messagesToCompress.flatMap((message) => extractStructuredMediaIds(message.content))));
    const captions = imageIds.length > 0
      ? await this.mediaCaptionService.ensureReady(imageIds, { reason: "history_compression" })
      : new Map<string, string>();
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
        force
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
        messagesToCompress
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
        { sessionId, expectedHistoryRevision },
        "history_compression_skipped_history_revision_mismatch"
      );
      return false;
    }

    this.logger.info(
      {
        sessionId,
        summaryLength: summary.length,
        retainedMessages: snapshot.retainedMessages.length,
        force
      },
      "history_compression_succeeded"
    );
    return true;
  }

  private resolveModelRefs(): string[] {
    return getModelRefsForRole(this.config, "summarizer");
  }
}
