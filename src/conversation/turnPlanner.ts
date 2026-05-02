import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { getPrimaryModelProfile } from "#llm/shared/modelProfiles.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import { analyzeTurnPlannerBatch } from "./turnPlannerBatchAnalysis.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { SpecialRole } from "#identity/specialRole.ts";
import { buildTurnPlannerPrompt } from "#llm/prompts/turn-planner.prompt.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import type { ChatFileStore } from "#services/workspace/chatFileStore.ts";
import type { MediaVisionService } from "#services/workspace/mediaVisionService.ts";
import type { MediaCaptionService } from "#services/workspace/mediaCaptionService.ts";
import type { ToolsetView } from "#llm/tools/toolsets.ts";
import { annotateHistoryMessagesWithCaptions, collectReferencedImageIds } from "#images/imagePromptContext.ts";
import { collectVisualAttachmentFileIds, isPendingChatAttachmentId } from "#services/workspace/chatAttachments.ts";

export type TurnPlannerRequiredCapability =
  | "external_info_lookup"
  | "web_navigation"
  | "local_file_access"
  | "shell_execution"
  | "memory_write"
  | "scheduler_management"
  | "time_lookup"
  | "social_admin"
  | "conversation_navigation"
  | "chat_delegation"
  | "image_generation";

export type TurnPlannerContextDependency =
  | "structured_message_context"
  | "prior_web_context"
  | "prior_shell_context"
  | "prior_file_context"
  | "prior_chat_context";

export type TurnPlannerFollowupMode = "none" | "elliptical" | "explicit_reference";

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
  replyDecision: "reply_small" | "reply_large" | "wait" | "no_reply";
  topicDecision: "continue_topic" | "new_topic";
  reason: string;
  requiredCapabilities: TurnPlannerRequiredCapability[];
  contextDependencies: TurnPlannerContextDependency[];
  recentDomainReuse: string[];
  followupMode: TurnPlannerFollowupMode;
  toolsetIds: string[];
  reasoningContent?: string;
}

type TurnPlannerMediaCaptionKind = "image" | "emoji";

interface TurnPlannerMediaCaption {
  imageId: string;
  kind: TurnPlannerMediaCaptionKind;
  caption: string;
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
    private readonly logger: Logger,
    private readonly mediaCaptionService?: Pick<MediaCaptionService, "ensureReady">
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
        requiredCapabilities: [],
        contextDependencies: [],
        recentDomainReuse: [],
        followupMode: "none",
        toolsetIds: []
      };
    }

    const startedAt = Date.now();
    const plannerModelRefs = this.resolveModelRefs();
    const recentMessages = input.recentMessages.slice(-this.config.llm.turnPlanner.recentMessageCount);
    const batchAnalysis = analyzeTurnPlannerBatch(input.batchMessages);
    const plannerProfile = getPrimaryModelProfile(this.config, plannerModelRefs);
    const captionContext = await this.prepareCaptionContext(input, recentMessages, plannerProfile?.supportsVision === true);
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
        mediaCaptionCount: captionContext.mediaCaptions.length,
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
          recentMessages: captionContext.recentMessages,
          batchAnalysis,
          emojiInputs,
          mediaCaptions: captionContext.mediaCaptions
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
        requiredCapabilities: [],
        contextDependencies: [],
        recentDomainReuse: [],
        followupMode: "none",
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
    const structured = parseStructuredPlannerResult(trimmed);
    if (structured) {
      return structured;
    }
    const line4Match = trimmed.match(/^(.+?)\s*\|\s*(reply_small|reply_large|wait|no_reply|ignore|reply|topic_switch)\s*\|\s*(continue_topic|new_topic)\s*\|\s*(.+)\s*$/is);
    if (line4Match) {
      return {
        ...normalizeParsedDecisions(line4Match[2], line4Match[3]),
        reason: summarizeReasonForLog(line4Match[1] ?? "", 160),
        requiredCapabilities: [],
        contextDependencies: [],
        recentDomainReuse: [],
        followupMode: "none",
        toolsetIds: parseToolsetIds(line4Match[4] ?? "")
      };
    }

    const tripleMatch = trimmed.match(/^(.+?)\s*\|\s*(reply_small|reply_large|wait|no_reply|ignore|reply|topic_switch)\s*\|\s*(continue_topic|new_topic)\s*$/is);
    if (tripleMatch) {
      return {
        ...normalizeParsedDecisions(tripleMatch[2], tripleMatch[3]),
        reason: summarizeReasonForLog(tripleMatch[1] ?? "", 160),
        requiredCapabilities: [],
        contextDependencies: [],
        recentDomainReuse: [],
        followupMode: "none",
        toolsetIds: []
      };
    }

    try {
      const parsed = JSON.parse(trimmed) as {
        decision?: unknown;
        replyDecision?: unknown;
        topicDecision?: unknown;
        requiredCapabilities?: unknown;
        contextDependencies?: unknown;
        recentDomainReuse?: unknown;
        followupMode?: unknown;
        reason?: unknown;
        toolsetIds?: unknown;
        toolsets?: unknown;
      };
      return {
        ...normalizeParsedDecisions(parsed.replyDecision ?? parsed.decision, parsed.topicDecision),
        reason: summarizeReasonForLog(typeof parsed.reason === "string" ? parsed.reason : "", 160),
        requiredCapabilities: parseRequiredCapabilities(parsed.requiredCapabilities),
        contextDependencies: parseContextDependencies(parsed.contextDependencies),
        recentDomainReuse: parseStringList(parsed.recentDomainReuse),
        followupMode: normalizeFollowupMode(parsed.followupMode),
        toolsetIds: parseUnknownToolsetIds(parsed.toolsetIds ?? parsed.toolsets)
      };
    } catch {
      // ignore
    }

    const fallbackDecision = trimmed.match(/\b(reply_small|reply_large|wait|no_reply|ignore|reply|topic_switch)\b/is)?.[1];
    return {
      ...normalizeParsedDecisions(fallbackDecision ?? "reply_small", "continue_topic"),
      reason: summarizeReasonForLog(trimmed, 160),
      requiredCapabilities: [],
      contextDependencies: [],
      recentDomainReuse: [],
      followupMode: "none",
      toolsetIds: []
    };
  }

  private resolveModelRefs(): string[] {
    return getModelRefsForRole(this.config, "turn_planner");
  }

  private async prepareCaptionContext(
    input: TurnPlannerInput,
    recentMessages: TurnPlannerInput["recentMessages"],
    supportsVision: boolean
  ): Promise<{
    recentMessages: TurnPlannerInput["recentMessages"];
    mediaCaptions: TurnPlannerMediaCaption[];
  }> {
    if (supportsVision || !this.mediaCaptionService) {
      return { recentMessages, mediaCaptions: [] };
    }

    const historyImageIds = collectReferencedImageIds(recentMessages);
    const batchRefs = collectBatchMediaRefs(input.batchMessages);
    const imageIds = uniqueIds([...historyImageIds, ...batchRefs.map((item) => item.imageId)]);
    if (imageIds.length === 0) {
      return { recentMessages, mediaCaptions: [] };
    }

    try {
      const captions = await this.mediaCaptionService.ensureReady(imageIds, {
        reason: "turn_planner_caption_context",
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      });
      return {
        recentMessages: annotateHistoryMessagesWithCaptions(recentMessages, captions, { includeIds: true }),
        mediaCaptions: batchRefs
          .map((item) => {
            const caption = captions.get(item.imageId);
            return caption ? { ...item, caption } : null;
          })
          .filter((item): item is TurnPlannerMediaCaption => item != null)
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          sessionId: input.sessionId,
          imageIds,
          error: error instanceof Error ? error.message : String(error)
        },
        "turn_planner_image_caption_context_failed"
      );
      return { recentMessages, mediaCaptions: [] };
    }
  }

  private normalizeDecision(
    parsed: TurnPlannerResult,
    input: TurnPlannerInput,
    batchAnalysis: ReturnType<typeof analyzeTurnPlannerBatch>
  ): TurnPlannerResult {
    const allowedToolsetIds = new Set((input.availableToolsets ?? []).map((item) => item.id));
    const filteredToolsetIds = parsed.replyDecision === "wait" || parsed.replyDecision === "no_reply"
      ? []
      : Array.from(new Set(parsed.toolsetIds.filter((id) => allowedToolsetIds.has(id))));
    const normalized = { ...parsed, toolsetIds: filteredToolsetIds };

    if (normalized.replyDecision === "no_reply") {
      if (input.chatType === "private") {
        this.logger.info(
          {
            sessionId: input.sessionId,
            reason: normalized.reason || "private no_reply not allowed"
          },
          "turn_planner_no_reply_coerced_to_reply"
        );
        return {
          ...normalized,
          replyDecision: "reply_small",
          topicDecision: "continue_topic",
          toolsetIds: []
        };
      }
      return {
        ...normalized,
        topicDecision: "continue_topic",
        toolsetIds: []
      };
    }

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
        requiredCapabilities: normalized.requiredCapabilities,
        contextDependencies: normalized.contextDependencies,
        recentDomainReuse: normalized.recentDomainReuse,
        followupMode: normalized.followupMode,
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

function collectBatchMediaRefs(messages: TurnPlannerInput["batchMessages"]): Array<{
  imageId: string;
  kind: TurnPlannerMediaCaptionKind;
}> {
  const refs: Array<{ imageId: string; kind: TurnPlannerMediaCaptionKind }> = [];
  const seen = new Set<string>();
  const add = (imageId: string, kind: TurnPlannerMediaCaptionKind): void => {
    const normalized = String(imageId ?? "").trim();
    if (!normalized || isPendingChatAttachmentId(normalized) || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    refs.push({ imageId: normalized, kind });
  };

  for (const message of messages) {
    for (const imageId of message.imageIds ?? []) {
      add(imageId, "image");
    }
    for (const emojiId of message.emojiIds ?? []) {
      add(emojiId, "emoji");
    }
    for (const imageId of collectVisualAttachmentFileIds(message.attachments, "image")) {
      add(imageId, "image");
    }
    for (const emojiId of collectVisualAttachmentFileIds(message.attachments, "emoji")) {
      add(emojiId, "emoji");
    }
  }

  return refs;
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((item) => String(item ?? "").trim()).filter(Boolean)));
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
  const normalized = sanitizeReason(value);
  if (!normalized || normalized === "-" || normalized === "none") {
    return [];
  }
  return normalized.split(/[\s,，|]+/g).map((item) => item.trim()).filter(Boolean);
}

function parseStructuredPlannerResult(raw: string): TurnPlannerResult | null {
  const fieldMap = new Map<string, string>();
  for (const line of raw.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!match) {
      return null;
    }
    fieldMap.set(match[1] ?? "", (match[2] ?? "").trim());
  }
  if (!fieldMap.has("reason") || !fieldMap.has("reply_decision") || !fieldMap.has("topic_decision")) {
    return null;
  }
  return {
    ...normalizeParsedDecisions(fieldMap.get("reply_decision"), fieldMap.get("topic_decision")),
    reason: summarizeReasonForLog(fieldMap.get("reason") ?? "", 160),
    requiredCapabilities: parseRequiredCapabilities(fieldMap.get("required_capabilities")),
    contextDependencies: parseContextDependencies(fieldMap.get("context_dependencies")),
    recentDomainReuse: parseStringList(fieldMap.get("recent_domain_reuse")),
    followupMode: normalizeFollowupMode(fieldMap.get("followup_mode")),
    toolsetIds: parseToolsetIds(fieldMap.get("toolset_ids") ?? "")
  };
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const normalized = sanitizeReason(value);
    if (!normalized || normalized.toLowerCase() === "none" || normalized === "-") {
      return [];
    }
    return normalized.split(/[\s,，|]+/g).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function parseRequiredCapabilities(value: unknown): TurnPlannerRequiredCapability[] {
  return parseStringList(value)
    .filter((item): item is TurnPlannerRequiredCapability => isRequiredCapability(item));
}

function parseContextDependencies(value: unknown): TurnPlannerContextDependency[] {
  return parseStringList(value)
    .filter((item): item is TurnPlannerContextDependency => isContextDependency(item));
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
  if (normalized === "no_reply" || normalized === "ignore") {
    return "no_reply";
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

function normalizeFollowupMode(input: unknown): TurnPlannerFollowupMode {
  const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (normalized === "elliptical" || normalized === "explicit_reference") {
    return normalized;
  }
  return "none";
}

function isRequiredCapability(value: string): value is TurnPlannerRequiredCapability {
  return [
    "external_info_lookup",
    "web_navigation",
    "local_file_access",
    "shell_execution",
    "memory_write",
    "scheduler_management",
    "time_lookup",
    "social_admin",
    "conversation_navigation",
    "chat_delegation",
    "image_generation"
  ].includes(value);
}

function isContextDependency(value: string): value is TurnPlannerContextDependency {
  return [
    "structured_message_context",
    "prior_web_context",
    "prior_shell_context",
    "prior_file_context",
    "prior_chat_context"
  ].includes(value);
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
  if (replyDecision === "no_reply") {
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
