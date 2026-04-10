import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { getPrimaryModelProfile, resolveModelRefsForType } from "#llm/shared/modelProfiles.ts";
import { analyzeTurnPlannerBatch } from "./turnPlannerBatchAnalysis.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { SpecialRole } from "#identity/specialRole.ts";
import { buildTurnPlannerPrompt } from "#llm/prompts/turn-planner.prompt.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { MediaVisionService } from "#services/workspace/mediaVisionService.ts";
import type { ToolsetView } from "#llm/tools/toolsets.ts";

export interface TurnPlannerInput {
  sessionId: string;
  chatType: "private" | "group";
  relationship: Relationship;
  currentUserSpecialRole?: SpecialRole | null;
  recentMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs?: number | null }>;
  abortSignal?: AbortSignal;
  availableToolsets?: ToolsetView[];
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

export interface TurnPlannerResult {
  replyDecision: "reply_small" | "reply_large" | "wait";
  topicDecision: "continue_topic" | "new_topic";
  reason: string;
  toolsetIds: string[];
  reasoningContent?: string;
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

export class TurnPlanner {
  constructor(
    private readonly config: AppConfig,
    private readonly llmClient: LlmClient,
    private readonly chatFileStore: Pick<ChatFileStore, "getMany">,
    private readonly mediaVisionService: Pick<MediaVisionService, "prepareFilesForModel">,
    private readonly logger: Logger
  ) {}

  isEnabled(): boolean {
    return this.config.llm.enabled
      && this.config.llm.turnPlanner.enabled
      && this.resolveModelRefs().length > 0;
  }

  async decide(input: TurnPlannerInput): Promise<TurnPlannerResult> {
    if (!this.isEnabled()) {
      return {
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        reason: "turn planner disabled",
        toolsetIds: []
      };
    }

    const startedAt = Date.now();
    const plannerModelRefs = this.resolveModelRefs();
    const recentMessages = input.recentMessages.slice(-this.config.llm.turnPlanner.recentMessageCount);
    const batchAnalysis = analyzeTurnPlannerBatch(input.batchMessages);
    const plannerProfile = getPrimaryModelProfile(this.config, plannerModelRefs);
    const emojiImageIds = plannerProfile?.supportsVision
      ? Array.from(new Set(input.batchMessages.flatMap((message) => (
        message.attachments
          ?.filter((item) => item.semanticKind === "emoji" && (item.kind === "image" || item.kind === "animated_image"))
          .map((item) => item.fileId)
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
        const files = await this.chatFileStore.getMany(emojiImageIds);
        const existingIds = new Set(files.map((item) => item.fileId));
        emojiInputs = (await this.mediaVisionService.prepareFilesForModel(emojiImageIds))
          .filter((item) => existingIds.has(item.fileId))
          .map((item) => ({
            imageId: item.fileId,
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
          "turn_planner_emoji_prepare_failed"
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
        emojiInputCount: emojiInputs.length,
        availableToolsetCount: (input.availableToolsets ?? []).length
      },
      "turn_planner_started"
    );

    let raw: string;
    let plannerReasoningContent = "";
    try {
      const result = await this.llmClient.generate({
        modelRefOverride: plannerModelRefs,
        timeoutMsOverride: this.config.llm.turnPlanner.timeoutMs,
        enableThinkingOverride: this.config.llm.turnPlanner.enableThinking,
        preferNativeNoThinkingChatEndpoint: true,
        skipDebugDump: true,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        messages: buildTurnPlannerPrompt({
          ...input,
          availableToolsets: input.availableToolsets ?? [],
          recentMessages,
          batchAnalysis,
          emojiInputs
        })
      });
      raw = result.text;
      plannerReasoningContent = result.reasoningContent ?? "";
    } catch (error: unknown) {
      const durationMs = Date.now() - startedAt;
      if (input.abortSignal?.aborted || isAbortError(error)) {
        this.logger.info({ sessionId: input.sessionId, durationMs }, "turn_planner_aborted");
      } else {
        this.logger.warn({ sessionId: input.sessionId, durationMs, err: error }, "turn_planner_llm_failed");
      }
      return {
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        reason: "turn planner failed",
        toolsetIds: []
      };
    }

    const parsedRaw = this.normalizeDecision(this.parseDecision(raw), input, batchAnalysis);
    const parsed: TurnPlannerResult = plannerReasoningContent
      ? { ...parsedRaw, reasoningContent: plannerReasoningContent }
      : parsedRaw;
    const logReason = summarizeReasonForLog(parsed.reason);
    const durationMs = Date.now() - startedAt;
    this.logger.info(
      {
        sessionId: input.sessionId,
        replyDecision: parsed.replyDecision,
        topicDecision: parsed.topicDecision,
        toolsetIds: parsed.toolsetIds,
        ...(logReason ? { reason: logReason } : {}),
        durationMs
      },
      "turn_planner_decided"
    );
    if (durationMs >= 3000) {
      this.logger.warn(
        {
          sessionId: input.sessionId,
          durationMs,
          model: getPrimaryModelProfile(this.config, plannerModelRefs)?.model ?? null,
          modelRef: plannerModelRefs
        },
        "turn_planner_slow"
      );
    }
    return parsed;
  }

  private parseDecision(raw: string): TurnPlannerResult {
    const trimmed = raw.trim();
    const line4Match = trimmed.match(/^(.+?)\s*\|\s*(reply_small|reply_large|wait|reply|topic_switch)\s*\|\s*(continue_topic|new_topic)\s*\|\s*(.+)\s*$/is);
    if (line4Match) {
      return {
        ...normalizeParsedDecisions(line4Match[2], line4Match[3]),
        reason: summarizeReasonForLog(line4Match[1] ?? "", 160),
        toolsetIds: parseToolsetIds(line4Match[4] ?? "")
      };
    }

    const tripleMatch = trimmed.match(/^(.+?)\s*\|\s*(reply_small|reply_large|wait|reply|topic_switch)\s*\|\s*(continue_topic|new_topic)\s*$/is);
    if (tripleMatch) {
      return {
        ...normalizeParsedDecisions(tripleMatch[2], tripleMatch[3]),
        reason: summarizeReasonForLog(tripleMatch[1] ?? "", 160),
        toolsetIds: []
      };
    }

    try {
      const parsed = JSON.parse(trimmed) as {
        decision?: unknown;
        replyDecision?: unknown;
        topicDecision?: unknown;
        reason?: unknown;
        toolsetIds?: unknown;
        toolsets?: unknown;
      };
      return {
        ...normalizeParsedDecisions(parsed.replyDecision ?? parsed.decision, parsed.topicDecision),
        reason: summarizeReasonForLog(typeof parsed.reason === "string" ? parsed.reason : "", 160),
        toolsetIds: parseUnknownToolsetIds(parsed.toolsetIds ?? parsed.toolsets)
      };
    } catch {
      // ignore
    }

    const fallbackDecision = trimmed.match(/\b(reply_small|reply_large|wait|reply|topic_switch)\b/is)?.[1];
    return {
      ...normalizeParsedDecisions(fallbackDecision ?? "reply_small", "continue_topic"),
      reason: summarizeReasonForLog(trimmed, 160),
      toolsetIds: []
    };
  }

  private resolveModelRefs(): string[] {
    const resolved = resolveModelRefsForType(this.config, this.config.llm.turnPlanner.modelRef, "chat");
    for (const rejected of resolved.rejectedModelRefs) {
      if (rejected.reason === "unsupported_model_type") {
        this.logger.warn(
          {
            modelRef: rejected.modelRef,
            actualModelType: rejected.actualModelType ?? "unknown"
          },
          "turn_planner_model_skipped_due_to_type"
        );
      }
    }
    return resolved.acceptedModelRefs;
  }

  private normalizeDecision(
    parsed: TurnPlannerResult,
    input: TurnPlannerInput,
    batchAnalysis: ReturnType<typeof analyzeTurnPlannerBatch>
  ): TurnPlannerResult {
    const allowedToolsetIds = new Set((input.availableToolsets ?? []).map((item) => item.id));
    const filteredToolsetIds = parsed.replyDecision === "wait"
      ? []
      : Array.from(new Set(parsed.toolsetIds.filter((id) => allowedToolsetIds.has(id))));
    const normalized = { ...parsed, toolsetIds: filteredToolsetIds };

    if (normalized.replyDecision !== "wait") {
      return normalized;
    }

    if (!shouldHonorWaitDecision(input, batchAnalysis, normalized.reason)) {
      this.logger.info(
        {
          sessionId: input.sessionId,
          reason: normalized.reason || "wait decision not justified by local heuristics"
        },
        "turn_planner_wait_coerced_to_reply"
      );
      return {
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        reason: normalized.reason || "wait coerced to reply",
        toolsetIds: []
      };
    }

    return {
      ...normalized,
      topicDecision: "continue_topic",
      toolsetIds: []
    };
  }
}

function parseUnknownToolsetIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return parseToolsetIds(value);
  }
  return [];
}

function parseToolsetIds(value: string): string[] {
  const normalized = sanitizeReason(value).toLowerCase();
  if (!normalized || normalized === "-" || normalized === "none") {
    return [];
  }
  return normalized.split(/[\s,，|]+/g).map((item) => item.trim()).filter(Boolean);
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

function normalizeReplyDecision(input: unknown): TurnPlannerResult["replyDecision"] {
  const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (normalized === "reply_large") {
    return normalized;
  }
  if (normalized === "wait") {
    return normalized;
  }
  return "reply_small";
}

function normalizeTopicDecision(input: unknown): TurnPlannerResult["topicDecision"] {
  const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (normalized === "new_topic" || normalized === "topic_switch") {
    return "new_topic";
  }
  return "continue_topic";
}

function normalizeParsedDecisions(
  replyInput: unknown,
  topicInput: unknown
): Pick<TurnPlannerResult, "replyDecision" | "topicDecision"> {
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
  input: TurnPlannerInput,
  batchAnalysis: ReturnType<typeof analyzeTurnPlannerBatch>,
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
