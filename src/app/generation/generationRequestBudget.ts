import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { LlmMessage, LlmToolDefinition } from "#llm/provider/providerTypes.ts";
import { estimateRequestTokens, type RequestTokenBudget } from "#llm/shared/requestTokenBudget.ts";
import { renderPromptSection } from "#llm/prompts/prompt-section.ts";
import { projectProviderWorkingMessagesForBudget } from "./providerWorkingMessageBudget.ts";

/** Application-owned compaction. The provider layer only supplies capacity and validates. */
export async function prepareGenerationRequestBudget(input: {
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  modelRef: string;
  budget: RequestTokenBudget;
  config: AppConfig;
  sessionId: string;
  logger: Logger;
  transcript: InternalTranscriptItem[];
  compact: () => Promise<{ summary: string; compressedTimestamps: number[] } | null>;
}): Promise<LlmMessage[]> {
  const projection = projectProviderWorkingMessagesForBudget({ ...input, triggerTokens: input.budget.inputTokens });
  let messages = projection.messages;
  let summaryApplied = false;
  const fixedMessages = messages.filter(message => message.contextHistoryTimestampMs == null && !message.contextHistorySummary);
  const canReclaimHistory = messages.some(message => message.contextHistoryTimestampMs != null || message.contextHistorySummary)
    && estimateRequestTokens(fixedMessages, input.tools, input.config) < input.budget.inputTokens;
  if (projection.afterTokens > input.budget.inputTokens && canReclaimHistory) {
    input.logger.info({ sessionId: input.sessionId, modelRef: input.modelRef, ...input.budget,
      beforeTokens: projection.beforeTokens, afterTokens: projection.afterTokens }, "generation_request_budget_compacting");
    const compacted = await input.compact();
    if (compacted) {
      const compressedTimestamps = new Set(compacted.compressedTimestamps);
      messages = messages.filter(message => !message.contextHistorySummary
        && (message.contextHistoryTimestampMs == null || !compressedTimestamps.has(message.contextHistoryTimestampMs)));
      const summary: LlmMessage = { role: "system", contextHistorySummary: true,
        content: renderPromptSection("history_summary", [compacted.summary])! };
      // Keep the stable system first. Current turn and tool-loop messages carry no history marker.
      messages = [...messages.slice(0, 1), summary, ...messages.slice(1)];
      summaryApplied = true;
    }
  }
  const afterTokens = estimateRequestTokens(messages, input.tools, input.config);
  input.logger.info({ sessionId: input.sessionId, modelRef: input.modelRef,
    ...input.budget, beforeTokens: projection.beforeTokens, afterTokens,
      compactedToolResults: projection.compactedToolResults, summaryApplied }, "generation_request_budget");
  return messages;
}
