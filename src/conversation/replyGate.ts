import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { getPrimaryModelProfile, resolveModelRefsForType } from "#llm/shared/modelProfiles.ts";
import { analyzeReplyGateBatch } from "./replyGateBatchAnalysis.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { SpecialRole } from "#identity/specialRole.ts";
import { buildReplyGatePrompt } from "#llm/prompts/reply-gate.prompt.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import type { MediaWorkspace } from "#services/workspace/mediaWorkspace.ts";
import type { MediaVisionService } from "#services/workspace/mediaVisionService.ts";

export interface ReplyGateInput {
  sessionId: string;
  chatType: "private" | "group";
  relationship: Relationship;
  currentUserSpecialRole?: SpecialRole | null;
  recentMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs?: number | null }>;
  abortSignal?: AbortSignal;
  batchMessages: Array<{
    senderName: string;
    text: string;
    images: string[];
    audioSources: string[];
    imageIds: string[];
    emojiIds: string[];
    attachments?: ChatAttachment[];
    forwardIds: string[];
    replyMessageId: string | null;
    mentionUserIds: string[];
    mentionedAll: boolean;
    mentionedSelf: boolean;
    timestampMs?: number | null;
  }>;
}

export interface ReplyGateResult {
  replyDecision: "reply_small" | "reply_large" | "wait";
  topicDecision: "continue_topic" | "new_topic";
  reason: string;
}

const MAX_LOG_REASON_LENGTH = 96;
const NO_REPLY_WAIT_REASON_PATTERNS = [
  /(?:无需回复|不需要回复|不用回复|无需回应|不用回应|不必回复|不必回应)/u,
  /(?:只是反馈|只是确认|只是告知|只是陈述|只是附和|只是回应)/u,
  /(?:收尾|结束话题|结束对话|结束聊天|礼貌收尾|简单收尾)/u,
  /(?:确认收到|表示收到|表示感谢|单纯感谢|致谢|客套)/u
] as const;
const LIKELY_UNFINISHED_TEXT_PATTERNS = [
  /^(比如|比如说|例如|譬如|然后|还有|另外|就是|先说|我想说)$/u,
  /(?:还没说完|还没发完|后面还有|继续发|先别回|稍等|等下|等等|我接着说)$/u,
  /[，、,:：([{（【\-]$/u,
  /(?:\.{3,}|…+)$/u
] as const;

export class ReplyGate {
  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly mediaWorkspace: Pick<MediaWorkspace, "getMany">,
    private readonly mediaVisionService: Pick<MediaVisionService, "prepareAssetsForModel">,
    private readonly logger: Logger
  ) {}

  isEnabled(): boolean {
    return this.config.llm.enabled
      && this.config.llm.replyGate.enabled
      && this.resolveModelRefs().length > 0;
  }

  async decide(input: ReplyGateInput): Promise<ReplyGateResult> {
    if (!this.isEnabled()) {
      return {
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        reason: "reply gate disabled"
      };
    }

    const startedAt = Date.now();
    const gateModelRefs = this.resolveModelRefs();
    const recentMessages = input.recentMessages.slice(-this.config.llm.replyGate.recentMessageCount);
    const batchAnalysis = analyzeReplyGateBatch(input.batchMessages);
    const gateProfile = getPrimaryModelProfile(this.config, gateModelRefs);
    const emojiImageIds = gateProfile?.supportsVision
      ? Array.from(new Set(input.batchMessages.flatMap((message) => (
        message.attachments
          ?.filter((item) => item.semanticKind === "emoji" && (item.kind === "image" || item.kind === "animated_image"))
          .map((item) => item.assetId)
          ?? []
      )))).slice(0, 5)
      : [];
    let emojiInputs: Array<{
      imageId: string;
      inputUrl: string;
      animated: boolean;
      durationMs: number | null;
      sampledFrameCount: number | null;
    }> = [];
    if (emojiImageIds.length > 0) {
      try {
        const assets = await this.mediaWorkspace.getMany(emojiImageIds);
        const existingIds = new Set(assets.map((item) => item.assetId));
        emojiInputs = (await this.mediaVisionService.prepareAssetsForModel(emojiImageIds))
          .filter((item) => existingIds.has(item.assetId))
          .map((item) => ({
          imageId: item.assetId,
          inputUrl: item.inputUrl,
          animated: item.animated,
          durationMs: item.durationMs,
          sampledFrameCount: item.sampledFrameCount
        }));
      } catch (error: unknown) {
        this.logger.warn(
          {
            sessionId: input.sessionId,
            emojiImageIds,
            error: error instanceof Error ? error.message : String(error)
          },
          "reply_gate_emoji_prepare_failed"
        );
      }
    }
    this.logger.debug(
      {
        sessionId: input.sessionId,
        chatType: input.chatType,
        relationship: input.relationship,
        recentMessageCount: recentMessages.length,
        batchMessageCount: input.batchMessages.length,
        batchFeatures: batchAnalysis.summaryTags,
        emojiInputCount: emojiInputs.length
      },
      "reply_gate_started"
    );

    let raw: string;
    try {
      const result = await this.llmClient.generate({
        modelRefOverride: gateModelRefs,
        timeoutMsOverride: this.config.llm.replyGate.timeoutMs,
        enableThinkingOverride: this.config.llm.replyGate.enableThinking,
        preferNativeNoThinkingChatEndpoint: true,
        skipDebugDump: true,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        messages: buildReplyGatePrompt({
          ...input,
          recentMessages,
          batchAnalysis,
          emojiInputs
        })
      });
      raw = result.text;
    } catch (error: unknown) {
      const durationMs = Date.now() - startedAt;
      if (input.abortSignal?.aborted || isAbortError(error)) {
        this.logger.info({ sessionId: input.sessionId, durationMs }, "reply_gate_aborted");
      } else {
        this.logger.warn({ sessionId: input.sessionId, durationMs, err: error }, "reply_gate_llm_failed");
      }
      return {
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        reason: "reply gate failed"
      };
    }

    const parsed = this.normalizeDecision(this.parseDecision(raw), input, batchAnalysis);
    const logReason = summarizeReasonForLog(parsed.reason);
    const durationMs = Date.now() - startedAt;
    this.logger.info(
      {
        sessionId: input.sessionId,
        replyDecision: parsed.replyDecision,
        topicDecision: parsed.topicDecision,
        ...(logReason ? { reason: logReason } : {}),
        durationMs
      },
      "reply_gate_decided"
    );
    if (durationMs >= 3000) {
      this.logger.warn(
        {
          sessionId: input.sessionId,
          durationMs,
          model: getPrimaryModelProfile(this.config, gateModelRefs)?.model ?? null,
          modelRef: gateModelRefs
        },
        "reply_gate_slow"
      );
    }
    return parsed;
  }

  private parseDecision(raw: string): ReplyGateResult {
    const trimmed = raw.trim();
    if (
      trimmed === "reply_small"
      || trimmed === "reply_large"
      || trimmed === "wait"
      || trimmed === "reply"
      || trimmed === "topic_switch"
    ) {
      return {
        ...normalizeParsedDecisions(trimmed, "continue_topic"),
        reason: ""
      };
    }
    const lineMatch = trimmed.match(/^(reply_small|reply_large|wait|reply|topic_switch)\s*\|\s*(.+)$/is);
    if (lineMatch) {
      const reason = sanitizeReason(lineMatch[2] ?? "");
      return {
        ...normalizeParsedDecisions(lineMatch[1], "continue_topic"),
        reason: summarizeReasonForLog(reason, 160)
      };
    }
    const trailingDecisionMatch = trimmed.match(/^(.+?)\s*\|\s*(reply_small|reply_large|wait|reply|topic_switch)\s*$/is);
    if (trailingDecisionMatch) {
      return {
        ...normalizeParsedDecisions(trailingDecisionMatch[2], "continue_topic"),
        reason: summarizeReasonForLog(trailingDecisionMatch[1] ?? "", 160)
      };
    }

    const tripleMatch = trimmed.match(/^(.+?)\s*\|\s*(reply_small|reply_large|wait|reply|topic_switch)\s*\|\s*(continue_topic|new_topic)\s*$/is);
    if (tripleMatch) {
      return {
        ...normalizeParsedDecisions(tripleMatch[2], tripleMatch[3]),
        reason: summarizeReasonForLog(tripleMatch[1] ?? "", 160)
      };
    }

    try {
      const parsed = JSON.parse(trimmed) as {
        decision?: unknown;
        replyDecision?: unknown;
        topicDecision?: unknown;
        reason?: unknown;
      };
      const reason = sanitizeReason(typeof parsed.reason === "string" ? parsed.reason : "");
      return {
        ...normalizeParsedDecisions(parsed.replyDecision ?? parsed.decision, parsed.topicDecision),
        reason: summarizeReasonForLog(reason, 160)
      };
    } catch {
      const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as {
            decision?: unknown;
            replyDecision?: unknown;
            topicDecision?: unknown;
            reason?: unknown;
          };
          const reason = sanitizeReason(typeof parsed.reason === "string" ? parsed.reason : "");
          return {
            ...normalizeParsedDecisions(parsed.replyDecision ?? parsed.decision, parsed.topicDecision),
            reason: summarizeReasonForLog(reason, 160)
          };
        } catch {
          // fall through to tolerant parsing
        }
      }
    }

    const tolerantTripleMatch = trimmed.match(/^(.+?)[\s|:：,-]+(reply_small|reply_large|wait|reply|topic_switch)[\s|:：,-]+(continue_topic|new_topic)\s*$/is);
    if (tolerantTripleMatch) {
      return {
        ...normalizeParsedDecisions(tolerantTripleMatch[2], tolerantTripleMatch[3]),
        reason: summarizeReasonForLog(tolerantTripleMatch[1] ?? "", 160)
      };
    }

    const tolerantTrailingDecisionMatch = trimmed.match(/^(.+?)[\s|:：,-]+(reply_small|reply_large|wait|reply|topic_switch)\s*$/is);
    if (tolerantTrailingDecisionMatch) {
      return {
        ...normalizeParsedDecisions(tolerantTrailingDecisionMatch[2], "continue_topic"),
        reason: summarizeReasonForLog(tolerantTrailingDecisionMatch[1] ?? "", 160)
      };
    }

    const tolerantLeadingDecisionMatch = trimmed.match(/\b(reply_small|reply_large|wait|reply|topic_switch)\b[\s|:：,-]*(.+)?/is);
    if (tolerantLeadingDecisionMatch) {
      return {
        ...normalizeParsedDecisions(tolerantLeadingDecisionMatch[1], "continue_topic"),
        reason: summarizeReasonForLog(tolerantLeadingDecisionMatch[2] ?? "", 160)
      };
    }

    this.logger.warn({ rawPreview: summarizeReasonForLog(trimmed, 240) }, "reply_gate_invalid_format");
    return {
      replyDecision: "reply_small",
      topicDecision: "continue_topic",
      reason: "invalid gate format fallback"
    };
  }

  private resolveModelRefs(): string[] {
    const resolved = resolveModelRefsForType(this.config, this.config.llm.replyGate.modelRef, "chat");
    for (const rejected of resolved.rejectedModelRefs) {
      if (rejected.reason === "unsupported_model_type") {
        this.logger.warn(
          {
            modelRef: rejected.modelRef,
            actualModelType: rejected.actualModelType ?? "unknown"
          },
          "reply_gate_model_skipped_due_to_type"
        );
      }
    }
    return resolved.acceptedModelRefs;
  }

  private normalizeDecision(
    parsed: ReplyGateResult,
    input: ReplyGateInput,
    batchAnalysis: ReturnType<typeof analyzeReplyGateBatch>
  ): ReplyGateResult {
    if (parsed.replyDecision !== "wait") {
      return parsed;
    }

    if (!shouldHonorWaitDecision(input, batchAnalysis, parsed.reason)) {
      this.logger.info(
        {
          sessionId: input.sessionId,
          reason: parsed.reason || "wait decision not justified by local heuristics"
        },
        "reply_gate_wait_coerced_to_reply"
      );
      return {
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        reason: parsed.reason || "wait coerced to reply"
      };
    }

    return {
      ...parsed,
      topicDecision: "continue_topic"
    };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}

function sanitizeReason(reason: string): string {
  return reason
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’|]+/g, "")
    .replace(/[\s"'“”‘’|]+$/g, "")
    .trim();
}

function summarizeReasonForLog(reason: string, maxLength = MAX_LOG_REASON_LENGTH): string {
  const normalized = sanitizeReason(reason);
  if (!normalized) {
    return "";
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength)}...`;
}

function normalizeReplyDecision(input: unknown): ReplyGateResult["replyDecision"] {
  const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (normalized === "reply_large") {
    return normalized;
  }
  if (normalized === "wait") {
    return normalized;
  }
  return "reply_small";
}

function normalizeTopicDecision(input: unknown): ReplyGateResult["topicDecision"] {
  const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (normalized === "new_topic" || normalized === "topic_switch") {
    return "new_topic";
  }
  return "continue_topic";
}

function normalizeParsedDecisions(replyInput: unknown, topicInput: unknown): Pick<ReplyGateResult, "replyDecision" | "topicDecision"> {
  if (replyInput === "topic_switch") {
    return {
      replyDecision: "reply_small",
      topicDecision: "new_topic"
    };
  }
  const replyDecision = normalizeReplyDecision(replyInput);
  if (replyDecision === "wait") {
    return {
      replyDecision,
      topicDecision: "continue_topic"
    };
  }
  return {
    replyDecision,
    topicDecision: normalizeTopicDecision(topicInput)
  };
}

function shouldHonorWaitDecision(
  input: ReplyGateInput,
  batchAnalysis: ReturnType<typeof analyzeReplyGateBatch>,
  reason: string
): boolean {
  if (looksLikeNoReplyRationale(reason)) {
    return false;
  }

  if (batchAnalysis.messageCount !== 1 || batchAnalysis.hasStructuredResolvableContent) {
    return false;
  }

  const message = input.batchMessages[0];
  const text = message?.text?.trim() ?? "";
  if (!text) {
    return false;
  }

  return LIKELY_UNFINISHED_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikeNoReplyRationale(reason: string): boolean {
  const normalized = sanitizeReason(reason);
  if (!normalized) {
    return false;
  }
  return NO_REPLY_WAIT_REASON_PATTERNS.some((pattern) => pattern.test(normalized));
}
