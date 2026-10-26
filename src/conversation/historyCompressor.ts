import type { Logger } from "pino";
import { estimateTokens } from "./session/tokenEstimator.ts";
import type { TopicCompressionCandidate } from "./turnPlannerPolicy.ts";
import type { AppConfig } from "#config/config.ts";
import { annotateStructuredMediaReferences, extractStructuredMediaIds } from "#images/imageReferences.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import { generateHistorySummary } from "./historySummaryGeneration.ts";
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
  triggerMessageCount?: number | undefined;
  retainMessageCount?: number | undefined;
}

export class HistoryCompressor {
  private readonly inFlightSessions = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly sessionManager: SessionCompressionAccess,
    private readonly mediaCaptionService: MediaCaptionService,
    private readonly logger: Logger,
    private readonly chatFileStore?: Pick<ChatFileStore, "getMany">
  ) {}

  getTopicCompressionCandidate(sessionId: string, recentMessageCountToKeep: number): TopicCompressionCandidate | null {
    if (!this.config.conversation.historyCompression.enabled || !this.config.llm.summarizer.enabled
      || !this.llmClient.isConfigured(this.resolveModelRefs()) || this.inFlightSessions.has(sessionId)) {
      return null;
    }
    const snapshot = this.sessionManager.getHistoryForCompression(sessionId, recentMessageCountToKeep, recentMessageCountToKeep);
    if (!snapshot) return null;
    const weights = this.config.conversation.historyCompression.tokenEstimation;
    const rawTokens = snapshot.messagesToCompress.reduce((total, message) => total + estimateTokens(message.content, weights), 0)
      + snapshot.toolObservationsToCompress.reduce((total, observation) => total + estimateTokens(JSON.stringify(observation), weights), 0);
    // Reserve half the source for the new summary. Existing summaries never satisfy the new-message threshold.
    return { messageCount: snapshot.messagesToCompress.length, estimatedReclaimableTokens: Math.floor(rawTokens / 2) };
  }

  /** Triggered only from the complete, candidate-specific request budget. */
  async compactForRequest(sessionId: string, retainTokens: number, abortSignal: AbortSignal): Promise<{ summary: string; compressedTimestamps: number[] } | null> {
    if (this.inFlightSessions.has(sessionId) || !this.config.conversation.historyCompression.enabled
      || !this.config.llm.summarizer.enabled || !this.llmClient.isConfigured(this.resolveModelRefs())) return null;
    abortSignal.throwIfAborted();
    const revision = this.sessionManager.getHistoryRevision(sessionId);
    const snapshot = this.sessionManager.selectHistoryForRequestCompression(sessionId, retainTokens);
    const retained = snapshot?.retainedMessages[0];
    if (!snapshot || !retained) return null;
    this.inFlightSessions.add(sessionId);
    let summary = "";
    try {
      const applied = await this.runCompression(sessionId, snapshot, revision, true, {
        triggerReason: "request_budget", triggerKind: "tokens", expectedHistoryRevision: revision
      }, { abortSignal, onSummary: value => { summary = value; } });
      return applied ? { summary, compressedTimestamps: snapshot.compressedTimestamps } : null;
    } finally {
      this.inFlightSessions.delete(sessionId);
    }
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
    logContext: CompressionLogContext,
    request?: { abortSignal: AbortSignal; onSummary: (summary: string) => void }
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

    const modeId = this.sessionManager.getModeId(sessionId);
    const summary = await generateHistorySummary({
      config: this.config, llmClient: this.llmClient,
      ...(request ? { abortSignal: request.abortSignal } : {}),
      prompt: { sessionId, modeId, existingSummary: snapshot.historySummary, messagesToCompress,
        toolObservationsToCompress: snapshot.toolObservationsToCompress }
    });
    request?.abortSignal.throwIfAborted();
    const sourceTokens = estimateTokens(snapshot.historySummary ?? "", this.config.conversation.historyCompression.tokenEstimation)
      + messagesToCompress.reduce((total, message) => total + estimateTokens(message.content, this.config.conversation.historyCompression.tokenEstimation), 0)
      + snapshot.toolObservationsToCompress.reduce((total, observation) => total + estimateTokens(JSON.stringify(observation), this.config.conversation.historyCompression.tokenEstimation), 0);
    if (!summary || (request && estimateTokens(summary, this.config.conversation.historyCompression.tokenEstimation) >= sourceTokens)) {
      this.logger.warn({ sessionId }, "history_compression_rejected_no_reduction");
      return false;
    }

    const currentModeId = this.sessionManager.getModeId(sessionId);
    if (currentModeId !== modeId) {
      this.logger.info(
        { sessionId, ...logContext, modeId, currentModeId },
        "history_compression_skipped_mode_mismatch"
      );
      return false;
    }

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

    request?.onSummary(summary);
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
