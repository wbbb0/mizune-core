import { turnPlannerRequiredCapabilities, turnPlannerContextDependencies } from "./types.ts";
import type { AppConfig } from "#config/config.ts";
import type { LlmClient } from "#llm/llmClient.ts";
import { buildTurnPlannerPrompt, buildTurnPlannerResponseFormat } from "#llm/prompts/turn-planner.prompt.ts";
import { parseTaskPlannerIntent } from "../taskTracker/taskTrackerPlannerContext.ts";
import { resolveTurnPlannerOutputTokenLimit } from "../turnPlannerPolicy.ts";
import { createDefaultTurnPlan } from "./result.ts";
import type { PreparedTurnPlannerInput, TurnPlannerContextDependency, TurnPlannerFollowupMode, TurnPlannerRequiredCapability, TurnPlannerResult, TurnPlannerEvaluation } from "./types.ts";

export async function evaluateWithChat(config: AppConfig, client: LlmClient, input: PreparedTurnPlannerInput, modelRefs: string[], timeoutMs: number): Promise<TurnPlannerEvaluation> {
  const responseFormat = client.supportsStructuredOutput?.(modelRefs)
    ? buildTurnPlannerResponseFormat(input.requirements, input.requirements.taskIntent && input.taskContext != null)
    : undefined;
  const maxOutputTokens = resolveTurnPlannerOutputTokenLimit(config, modelRefs);
  const result = await client.generate({
    ...(responseFormat ? { responseFormat } : {}),
    modelRefOverride: modelRefs,
    timeoutMsOverride: timeoutMs,
    ...(maxOutputTokens != null ? { maxOutputTokensOverride: maxOutputTokens } : {}),
    enableThinkingOverride: config.llm.turnPlanner.enableThinking,
    preferNativeNoThinkingChatEndpoint: true,
    skipDebugDump: true,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    messages: buildTurnPlannerPrompt({ ...input, structuredOutput: responseFormat !== undefined })
  });
  const plan = parseStructuredPlannerResult(result.text.trim()) ?? createDefaultTurnPlan("规划格式无效，继续回复");
  return { plan: { ...plan, ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}) }, ...(result.usage ? { usage: result.usage } : {}) };
}

const MAX_LOG_REASON_LENGTH = 96;
function parseToolsetIds(value: string): string[] {
  const normalized = sanitizeReason(value);
  if (!normalized || normalized === "-" || normalized === "none") {
    return [];
  }
  return normalized.split(/[\s,，|]+/g).map((item) => item.trim()).filter(Boolean);
}

export function parseStructuredPlannerResult(raw: string): TurnPlannerResult | null {
  const fieldMap = new Map<string, string>();
  if (raw.trimStart().startsWith("{")) {
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      for (const [key, field] of Object.entries(value)) {
        if (typeof field !== "string") return null;
        fieldMap.set(key, field.trim());
      }
    } catch { return null; }
  } else for (const line of raw.split(/\r?\n/g)) {
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
  if (!fieldMap.has("reason")) {
    return null;
  }
  const taskIntent = parseTaskPlannerIntent(fieldMap.get("task_intent"));
  return {
    ...normalizeParsedDecisions(fieldMap.get("reply_decision"), fieldMap.get("topic_decision")),
    reason: summarizeReasonForLog(fieldMap.get("reason") ?? "", 160),
    waitReason: fieldMap.get("wait_reason") === "unfinished_message" ? "unfinished_message" : "none",
    requiredCapabilities: parseRequiredCapabilities(fieldMap.get("required_capabilities")),
    contextDependencies: parseContextDependencies(fieldMap.get("context_dependencies")),
    recentDomainReuse: parseStringList(fieldMap.get("recent_domain_reuse")),
    followupMode: normalizeFollowupMode(fieldMap.get("followup_mode")),
    toolsetIds: parseToolsetIds(fieldMap.get("toolset_ids") ?? ""),
    skillIds: parseToolsetIds(fieldMap.get("skill_ids") ?? ""),
    ...(taskIntent ? { taskIntent } : {})
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
  if (normalized === "no_reply") {
    return "no_reply";
  }
  return "reply_small";
}

function normalizeTopicDecision(input: unknown): TurnPlannerResult["topicDecision"] {
  const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (normalized === "new_topic") {
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
  return (turnPlannerRequiredCapabilities as readonly string[]).includes(value);
}

function isContextDependency(value: string): value is TurnPlannerContextDependency {
  return (turnPlannerContextDependencies as readonly string[]).includes(value);
}

function normalizeParsedDecisions(
  replyInput: unknown,
  topicInput: unknown
): Pick<TurnPlannerResult, "replyDecision" | "topicDecision"> {
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
