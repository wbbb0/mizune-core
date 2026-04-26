import type { AppConfig } from "#config/config.ts";
import { projectTranscriptMessageItemToHistoryMessage } from "./historyContext.ts";
import { estimateTokens } from "./tokenEstimator.ts";
import type {
  InternalAssistantToolCallItem,
  InternalToolResultItem,
  InternalTranscriptItem,
  TranscriptAssistantMessageItem,
  TranscriptSessionModeSwitchItem,
  TranscriptTokenStat,
  TranscriptTokenStats,
  TranscriptUserMessageItem
} from "./sessionTypes.ts";

interface ProviderTokenStatInput {
  tokens: number | null;
  modelRef: string | null;
  model: string | null;
  providerReported: boolean;
  capturedAt: number;
}

interface OutputTokenStatsInput {
  outputTokens: number | null;
  reasoningTokens: number | null;
  modelRef: string | null;
  model: string | null;
  providerReported: boolean;
  capturedAt: number;
}

type HistoryTranscriptItem =
  | TranscriptUserMessageItem
  | TranscriptAssistantMessageItem
  | TranscriptSessionModeSwitchItem;

export function withEstimatedInputTokenStats<TItem extends InternalTranscriptItem>(
  item: TItem,
  config: AppConfig,
  updatedAt = Date.now()
): TItem {
  if (item.llmVisible !== true) {
    return item;
  }
  const tokens = estimateTranscriptItemInputTokens(item, config);
  if (tokens <= 0) {
    return item;
  }
  return {
    ...item,
    tokenStats: {
      ...item.tokenStats,
      input: createEstimatedTokenStat(tokens, updatedAt)
    }
  };
}

export function estimateTranscriptItemInputTokens(item: InternalTranscriptItem, config: AppConfig): number {
  const weights = config.conversation.historyCompression.tokenEstimation;
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
    case "session_mode_switch":
      return estimateTokens(projectTranscriptMessageItemToHistoryMessage(item as HistoryTranscriptItem).content, weights);
    case "assistant_tool_call":
      return estimateAssistantToolCallTokens(item, config);
    case "tool_result":
      return estimateToolResultTokens(item, config);
    default:
      return 0;
  }
}

export function getCachedOrEstimatedInputTokens(item: InternalTranscriptItem, config: AppConfig): number {
  const cached = item.tokenStats?.input?.tokens;
  if (typeof cached === "number" && Number.isFinite(cached)) {
    return cached;
  }
  return estimateTranscriptItemInputTokens(item, config);
}

export function createDirectTokenStat(input: ProviderTokenStatInput): TranscriptTokenStat | undefined {
  if (input.tokens == null || input.tokens < 0) {
    return undefined;
  }
  return {
    tokens: Math.round(input.tokens),
    source: "api_direct",
    modelRef: input.modelRef,
    model: input.model,
    providerReported: input.providerReported,
    sampleCount: 1,
    updatedAt: input.capturedAt
  };
}

export function createEstimatedTokenStat(tokens: number, updatedAt = Date.now()): TranscriptTokenStat {
  return {
    tokens: Math.max(0, Math.round(tokens)),
    source: "estimated",
    providerReported: false,
    sampleCount: 1,
    updatedAt
  };
}

export function createProviderOutputTokenStats(
  input: OutputTokenStatsInput,
  reasoningContent?: string,
  config?: AppConfig
): TranscriptTokenStats | undefined {
  const output = createDirectTokenStat({
    tokens: input.outputTokens,
    modelRef: input.modelRef,
    model: input.model,
    providerReported: input.providerReported,
    capturedAt: input.capturedAt
  });
  const directReasoning = createDirectTokenStat({
    tokens: input.reasoningTokens,
    modelRef: input.modelRef,
    model: input.model,
    providerReported: input.providerReported,
    capturedAt: input.capturedAt
  });
  const reasoning = directReasoning
    ?? (reasoningContent && config
      ? createEstimatedTokenStat(estimateTokens(reasoningContent, config.conversation.historyCompression.tokenEstimation), input.capturedAt)
      : undefined);

  if (!output && !reasoning) {
    return undefined;
  }
  return {
    ...(output ? { output } : {}),
    ...(reasoning ? { reasoning } : {})
  };
}

export function distributeProviderOutputTokenStats(input: {
  items: TranscriptAssistantMessageItem[];
  outputTokens: number | null;
  reasoningTokens: number | null;
  modelRef: string | null;
  model: string | null;
  providerReported: boolean;
  capturedAt: number;
  config: AppConfig;
}): TranscriptAssistantMessageItem[] {
  if (input.items.length === 0) {
    return input.items;
  }

  const outputWeights = input.items.map((item) => Math.max(1, estimateTokens(item.text, input.config.conversation.historyCompression.tokenEstimation)));
  const reasoningWeights = input.items.map((item) => (
    item.reasoningContent
      ? Math.max(1, estimateTokens(item.reasoningContent, input.config.conversation.historyCompression.tokenEstimation))
      : 0
  ));
  const outputShares = distributeTokens(input.outputTokens, outputWeights);
  const reasoningShares = distributeTokens(
    input.reasoningTokens,
    reasoningWeights.some((weight) => weight > 0) ? reasoningWeights : outputWeights
  );

  return input.items.map((item, index) => {
    const tokenStats: TranscriptTokenStats = { ...item.tokenStats };
    const output = createDirectTokenStat({
      tokens: outputShares[index] ?? null,
      modelRef: input.modelRef,
      model: input.model,
      providerReported: input.providerReported,
      capturedAt: input.capturedAt
    });
    if (output) {
      tokenStats.output = output;
    }
    const reasoning = createDirectTokenStat({
      tokens: reasoningShares[index] ?? null,
      modelRef: input.modelRef,
      model: input.model,
      providerReported: input.providerReported,
      capturedAt: input.capturedAt
    }) ?? (item.reasoningContent
      ? createEstimatedTokenStat(estimateTokens(item.reasoningContent, input.config.conversation.historyCompression.tokenEstimation), input.capturedAt)
      : undefined);
    if (reasoning) {
      tokenStats.reasoning = reasoning;
    }
    return {
      ...item,
      tokenStats
    };
  });
}

function estimateAssistantToolCallTokens(item: InternalAssistantToolCallItem, config: AppConfig): number {
  const weights = config.conversation.historyCompression.tokenEstimation;
  return item.toolCalls.reduce((sum, toolCall) => (
    sum
      + estimateTokens(toolCall.function.name, weights)
      + estimateTokens(toolCall.function.arguments, weights)
  ), estimateTokens(item.content, weights));
}

function estimateToolResultTokens(item: InternalToolResultItem, config: AppConfig): number {
  const weights = config.conversation.historyCompression.tokenEstimation;
  return item.observation?.inputTokensEstimate ?? estimateTokens(item.content, weights);
}

function distributeTokens(totalTokens: number | null, weights: number[]): Array<number | null> {
  if (totalTokens == null || totalTokens < 0 || weights.length === 0) {
    return weights.map(() => null);
  }
  const totalWeight = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (totalWeight <= 0) {
    return weights.map(() => null);
  }
  const rawShares = weights.map((weight) => (totalTokens * Math.max(0, weight)) / totalWeight);
  const floors = rawShares.map((share) => Math.floor(share));
  let remainder = Math.round(totalTokens) - floors.reduce((sum, value) => sum + value, 0);
  const order = rawShares
    .map((share, index) => ({ index, fraction: share - Math.floor(share) }))
    .sort((left, right) => right.fraction - left.fraction);
  for (const item of order) {
    if (remainder <= 0) {
      break;
    }
    floors[item.index] = (floors[item.index] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}
