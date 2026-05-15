import type { AppConfig } from "#config/config.ts";
import { getCachedOrEstimatedInputTokens } from "./transcriptTokenStats.ts";
import { estimateTokens } from "./tokenEstimator.ts";
import type { InternalAssistantToolCallItem, InternalToolResultItem, InternalTranscriptItem, SessionState } from "./sessionTypes.ts";

export const DEFAULT_FIXED_PROMPT_OVERHEAD_TOKENS = 3000;

export interface PromptTokenBudgetEstimate {
  reportedInputTokens?: number | undefined;
  estimatedTotalTokens: number;
  totalTokens: number;
  source: "estimated" | "estimated_with_provider_floor";
  summaryTokens: number;
  historyMessageTokens: number;
  toolReplayTokens: number;
  fixedOverheadTokens: number;
  historyContextTokens: number;
  reclaimableTranscriptTokens: number;
}

export function estimatePromptTokenBudget(input: {
  session: SessionState;
  config: AppConfig;
  reportedInputTokens?: number | undefined;
  retainTokens: number;
}): PromptTokenBudgetEstimate {
  const weights = input.config.conversation.historyCompression.tokenEstimation;
  const llmVisibleItems = input.session.internalTranscript.filter(isBudgetVisible);
  const summaryTokens = input.session.historySummary
    ? estimateTokens(input.session.historySummary, weights)
    : 0;
  const historyMessageTokens = llmVisibleItems
    .filter(isBudgetHistoryMessage)
    .reduce((sum, item) => sum + getCachedOrEstimatedInputTokens(item, input.config), 0);
  const toolReplayTokens = llmVisibleItems
    .filter((item): item is InternalAssistantToolCallItem | InternalToolResultItem => (
      item.kind === "assistant_tool_call" || item.kind === "tool_result"
    ))
    .reduce((sum, item) => sum + getCachedOrEstimatedInputTokens(item, input.config), 0);
  const fixedOverheadTokens = DEFAULT_FIXED_PROMPT_OVERHEAD_TOKENS;
  const historyContextTokens = summaryTokens + historyMessageTokens + toolReplayTokens;
  const estimatedTotalTokens = historyContextTokens + fixedOverheadTokens;
  const reportedInputTokens = normalizeReportedTokens(input.reportedInputTokens);
  const totalTokens = Math.max(estimatedTotalTokens, reportedInputTokens ?? 0);
  return {
    ...(reportedInputTokens != null ? { reportedInputTokens } : {}),
    estimatedTotalTokens,
    totalTokens,
    source: reportedInputTokens == null ? "estimated" : "estimated_with_provider_floor",
    summaryTokens,
    historyMessageTokens,
    toolReplayTokens,
    fixedOverheadTokens,
    historyContextTokens,
    reclaimableTranscriptTokens: Math.max(0, historyMessageTokens + toolReplayTokens - input.retainTokens)
  };
}

function normalizeReportedTokens(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export function resolvePromptBudgetReportedInputTokens(input: {
  inputTokens?: number | null | undefined;
  requestCount?: number | null | undefined;
}): number | undefined {
  return input.requestCount === 1
    ? normalizeReportedTokens(input.inputTokens ?? undefined)
    : undefined;
}

function isBudgetVisible(item: InternalTranscriptItem): boolean {
  return item.llmVisible === true && item.runtimeExcluded !== true && item.runtimeVisibility !== "ambient";
}

function isBudgetHistoryMessage(item: InternalTranscriptItem): boolean {
  return (
    item.kind === "user_message"
    || item.kind === "user_media_message"
    || item.kind === "assistant_message"
    || item.kind === "session_mode_switch"
  );
}
