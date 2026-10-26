import { estimateRequestTokens } from "#llm/shared/requestTokenBudget.ts";
export { estimateLlmMessagesTokens, estimateLlmToolsTokens } from "#llm/shared/requestTokenBudget.ts";
import type { AppConfig } from "#config/config.ts";
import type { InternalToolResultItem, InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { LlmMessage } from "#llm/llmClient.ts";
import type { LlmToolDefinition } from "#llm/provider/providerTypes.ts";
import { shouldUseToolResultReplayContent } from "./toolResultReplayPolicy.ts";

const DEFAULT_RECENT_RAW_TOOL_RESULT_COUNT = 5;

export interface ProviderWorkingMessageBudgetProjection {
  messages: LlmMessage[];
  beforeTokens: number;
  afterTokens: number;
  compactedToolResults: number;
}

export function projectProviderWorkingMessagesForBudget(input: {
  messages: LlmMessage[];
  transcript: InternalTranscriptItem[];
  tools?: LlmToolDefinition[];
  config: AppConfig;
  triggerTokens: number;
}): ProviderWorkingMessageBudgetProjection {
  const beforeTokens = estimateRequestTokens(input.messages, input.tools ?? [], input.config);
  if (beforeTokens <= input.triggerTokens) {
    return {
      messages: input.messages,
      beforeTokens,
      afterTokens: beforeTokens,
      compactedToolResults: 0
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

  return {
    messages: projected,
    beforeTokens,
    afterTokens: estimateRequestTokens(projected, input.tools ?? [], input.config),
    compactedToolResults
  };
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
