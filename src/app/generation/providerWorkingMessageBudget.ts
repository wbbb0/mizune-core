import type { AppConfig } from "#config/config.ts";
import type { InternalToolResultItem, InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import { estimateTokens } from "#conversation/session/tokenEstimator.ts";
import type { LlmMessage } from "#llm/llmClient.ts";
import type { LlmToolDefinition } from "#llm/provider/providerTypes.ts";
import { shouldUseToolResultReplayContent } from "./toolResultReplayPolicy.ts";

const DEFAULT_RECENT_RAW_TOOL_RESULT_COUNT = 5;
const TOOL_BUDGET_WARNING = "当前工具链上下文已接近上限。不要继续调用工具，请基于已有工具结果直接回复用户；如果任务仍未完成，请简要说明已完成内容、未完成部分和下一步建议。";

export interface ProviderWorkingMessageBudgetProjection {
  messages: LlmMessage[];
  beforeTokens: number;
  afterTokens: number;
  compactedToolResults: number;
  toolsDisabled: boolean;
}

export function projectProviderWorkingMessagesForBudget(input: {
  messages: LlmMessage[];
  transcript: InternalTranscriptItem[];
  tools?: LlmToolDefinition[];
  config: AppConfig;
  triggerTokens: number;
}): ProviderWorkingMessageBudgetProjection {
  const toolTokens = estimateLlmToolsTokens(input.tools ?? [], input.config);
  const beforeTokens = estimateLlmMessagesTokens(input.messages, input.config) + toolTokens;
  if (beforeTokens <= input.triggerTokens) {
    return {
      messages: input.messages,
      beforeTokens,
      afterTokens: beforeTokens,
      compactedToolResults: 0,
      toolsDisabled: false
    };
  }

  const observations = collectToolResultObservations(input.transcript);
  const toolEntries = input.messages
    .map((message, index) => ({ message, index }))
    .filter((item) => item.message.role === "tool" && typeof item.message.tool_call_id === "string");
  let compactedToolResults = 0;
  const projected = input.messages.map((message, index) => {
    if (message.role !== "tool" || typeof message.tool_call_id !== "string") {
      return message;
    }
    const toolPosition = toolEntries.findIndex((item) => item.index === index);
    const observation = observations.get(message.tool_call_id);
    if (!observation || shouldKeepRawToolResult(observation, toolPosition, toolEntries.length)) {
      return message;
    }
    if (
      !observation.replayContent
      || observation.replayContent === message.content
      || !shouldUseToolResultReplayContent({
        rawContent: renderMessageContentForTokenEstimate(message.content),
        replayContent: observation.replayContent,
        replaySafe: observation.replaySafe,
        tokenEstimationWeights: input.config.conversation.historyCompression.tokenEstimation
      })
    ) {
      return message;
    }
    compactedToolResults += 1;
    return {
      ...message,
      content: observation.replayContent
    };
  });

  const afterCompactionTokens = estimateLlmMessagesTokens(projected, input.config) + toolTokens;
  const toolsDisabled = afterCompactionTokens > input.triggerTokens;
  const finalMessages = toolsDisabled && !hasToolBudgetWarning(projected)
    ? [...projected, { role: "system" as const, content: TOOL_BUDGET_WARNING }]
    : projected;
  const afterTokens = toolsDisabled
    ? estimateLlmMessagesTokens(finalMessages, input.config)
    : afterCompactionTokens;

  return {
    messages: finalMessages,
    beforeTokens,
    afterTokens,
    compactedToolResults,
    toolsDisabled
  };
}

export function estimateLlmMessagesTokens(messages: LlmMessage[], config: AppConfig): number {
  const weights = config.conversation.historyCompression.tokenEstimation;
  return messages.reduce((sum, message) => (
    sum
      + estimateTokens(message.role, weights)
      + estimateTokens(renderMessageContentForTokenEstimate(message.content), weights)
      + estimateTokens(message.tool_call_id ?? "", weights)
      + estimateTokens(message.reasoning_content ?? "", weights)
      + estimateToolCallsTokens(message, config)
  ), 0);
}

export function estimateLlmToolsTokens(tools: LlmToolDefinition[], config: AppConfig): number {
  if (tools.length === 0) {
    return 0;
  }
  return estimateTokens(
    JSON.stringify(tools),
    config.conversation.historyCompression.tokenEstimation
  );
}

function estimateToolCallsTokens(message: LlmMessage, config: AppConfig): number {
  const weights = config.conversation.historyCompression.tokenEstimation;
  return (message.tool_calls ?? []).reduce((sum, toolCall) => (
    sum
      + estimateTokens(toolCall.id, weights)
      + estimateTokens(toolCall.function.name, weights)
      + estimateTokens(toolCall.function.arguments, weights)
  ), 0);
}

function renderMessageContentForTokenEstimate(content: LlmMessage["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function collectToolResultObservations(transcript: InternalTranscriptItem[]): Map<string, InternalToolResultItem["observation"]> {
  const observations = new Map<string, InternalToolResultItem["observation"]>();
  for (const item of transcript) {
    if (
      item.kind !== "tool_result"
      || item.runtimeExcluded === true
      || !item.toolCallId
      || !item.observation
    ) {
      continue;
    }
    observations.set(item.toolCallId, item.observation);
  }
  return observations;
}

function shouldKeepRawToolResult(
  observation: NonNullable<InternalToolResultItem["observation"]>,
  toolPosition: number,
  totalToolMessages: number
): boolean {
  if (observation.replaySafe === false) {
    return false;
  }
  if (observation.retention === "full" || observation.pinned === true || toolPosition < 0) {
    return true;
  }
  const preserveCount = observation.preserveRecentRawCount ?? DEFAULT_RECENT_RAW_TOOL_RESULT_COUNT;
  return toolPosition >= Math.max(0, totalToolMessages - preserveCount);
}

function hasToolBudgetWarning(messages: LlmMessage[]): boolean {
  return messages.some((message) => message.role === "system" && message.content === TOOL_BUDGET_WARNING);
}
