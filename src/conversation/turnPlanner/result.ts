import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { TurnPlannerBatchAnalysisMessage, analyzeTurnPlannerBatch } from "../turnPlannerBatchAnalysis.ts";
import type { TurnPlannerInput, TurnPlannerResult } from "./types.ts";
import { PLANNER_SKILL_LIMIT } from "./limits.ts";

export function createDefaultTurnPlan(reason: string): TurnPlannerResult {
  return { replyDecision: "reply", topicDecision: "continue_topic", reason,
    requiredCapabilities: [], contextDependencies: [], recentDomainReuse: [], followupMode: "none", toolsetIds: [] };
}

const LIKELY_UNFINISHED_TEXT_PATTERNS = [
  /^(比如|比如说|例如|譬如|然后|还有|另外|就是|先说|我想说)$/u,
  /(?:还没说完|还没发完|后面还有|继续发|先别回|稍等|等下|等等|我接着说)$/u,
  /[，、,:：([{（【\-]$/u,
  /(?:\.{3,}|…+)$/u
] as const;

export function normalizeTurnPlan(
  parsed: TurnPlannerResult,
  input: TurnPlannerInput,
  batchAnalysis: ReturnType<typeof analyzeTurnPlannerBatch>,
  config: AppConfig,
  logger: Logger
): TurnPlannerResult {
  const needs = input.requirements;
  parsed = {
    ...parsed,
    replyDecision: (parsed.replyDecision === "wait" && !needs.semanticWait)
      || (parsed.replyDecision === "no_reply" && !needs.replyGate)
      ? "reply" : parsed.replyDecision,
    modelSelectionStatus: !needs.modelSelection ? "not_requested" : parsed.modelSelectionStatus ?? "undetermined",
    topicDecision: needs.topicSwitch ? parsed.topicDecision : "continue_topic",
    topicDecisionEvaluated: needs.topicSwitch,
    requiredCapabilities: needs.toolSelection ? parsed.requiredCapabilities : [],
    contextDependencies: needs.toolSelection ? parsed.contextDependencies : [],
    recentDomainReuse: needs.toolSelection ? parsed.recentDomainReuse : [],
    followupMode: needs.toolSelection ? parsed.followupMode : "none",
    skillIds: needs.skillSelection && config.skills.plannerSelectionEnabled ? Array.from(new Set(parsed.skillIds ?? [])).filter(id => input.availableSkills?.some(skill => skill.id === id)).slice(0, PLANNER_SKILL_LIMIT) : [],
    toolsetIds: needs.toolSelection ? parsed.toolsetIds : []
  };
  const allowedToolsetIds = new Set((input.availableToolsets ?? []).map((item) => item.id));
  const filteredToolsetIds = Array.from(new Set(parsed.toolsetIds.filter((id) => allowedToolsetIds.has(id))));
  const normalized = { ...parsed, toolsetIds: filteredToolsetIds };
  if (!needs.modelSelection) delete normalized.modelTier;
  if (!needs.taskIntent || !input.taskContext) {
    delete normalized.taskIntent;
  }

  if (normalized.taskIntent?.targetTaskId && ![
    input.taskContext?.primary?.taskId, ...(input.taskContext?.parked.map(task => task.taskId) ?? [])
  ].includes(normalized.taskIntent.targetTaskId)) {
    normalized.taskIntent = { kind: "unknown", confidence: "low" };
  }

  if (normalized.replyDecision === "no_reply") {
    if (mustReplyToPlannerBatch(input.chatType, input.batchMessages)) {
      logger.info(
        {
          sessionId: input.sessionId,
          reason: normalized.reason || "private no_reply not allowed"
        },
        "turn_planner_no_reply_coerced_to_reply"
      );
      return {
        ...normalized,
        replyDecision: "reply",
        topicDecision: "continue_topic",
        reason: "必须回应当前消息",
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

  if (!shouldHonorWaitDecision(input, batchAnalysis, normalized.waitReason)) {
    logger.info(
      {
        sessionId: input.sessionId,
        reason: normalized.reason || "wait decision not justified by local heuristics"
      },
      "turn_planner_wait_coerced_to_reply"
    );
    return {
      ...normalized,
      replyDecision: "reply",
      topicDecision: "continue_topic",
      waitReason: "none",
      reason: "不满足等待条件，继续回复",
      toolsetIds: []
    };
  }

  return {
    ...normalized,
    topicDecision: "continue_topic",
    toolsetIds: []
  };
}

function shouldHonorWaitDecision(
  input: TurnPlannerInput,
  batchAnalysis: ReturnType<typeof analyzeTurnPlannerBatch>,
  waitReason: TurnPlannerResult["waitReason"]
): boolean {
  if (waitReason !== "unfinished_message") {
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

export function mustReplyToPlannerBatch(chatType: "private" | "group", messages: Array<TurnPlannerBatchAnalysisMessage & { images?: string[]; audioIds?: string[] }>): boolean {
  if (chatType === "private") return true;
  return messages.some(message => message.mentionedSelf || message.replyMessageId != null
    || (message.images?.length ?? 0) > 0
    || (message.contentParts?.some(part => part.kind !== "text" || part.text.trim().length > 0) ?? false)
    || (message.imageIds?.length ?? 0) > 0 || (message.audioSources?.length ?? 0) > 0
    || (message.audioIds?.length ?? 0) > 0 || (message.emojiIds?.length ?? 0) > 0
    || (message.attachments?.length ?? 0) > 0 || (message.messageFiles?.length ?? 0) > 0
    || (message.specialSegments?.length ?? 0) > 0 || (message.forwardIds?.length ?? 0) > 0 || message.mentionedAll);
}
