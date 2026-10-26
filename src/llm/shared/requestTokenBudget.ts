import { estimateMessageContentTokens } from "./messageContentTokens.ts";
import { estimateTokens } from "#conversation/session/tokenEstimator.ts";
import type { AppConfig } from "#config/config.ts";
import type { ModelProfile } from "#config/configModel.ts";
import type { LlmMessage, LlmToolDefinition, LlmProviderRequestContext } from "../provider/providerTypes.ts";
import { getRoutingPresetTokenLimits } from "./modelRouting.ts";

export class ModelRequestBudgetError extends Error { }

export interface RequestTokenBudget {
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  safetyTokens: number;
}

/** One capacity calculation for every actual candidate, including auxiliary models. */
export function resolveModelRequestBudget(
  profile: ModelProfile,
  presetContextTokens: number,
  requestedOutputTokens?: number,
  operation: "chat" | "transcription" = "chat"
): RequestTokenBudget {
  const settings = profile[operation];
  if (!settings) throw new ModelRequestBudgetError(`模型未配置 ${operation} 用途`);
  const limits = settings.limits;
  const contextTokens = Math.min(limits.contextTokens ?? Infinity, presetContextTokens);
  const safetyTokens = Math.min(1024, Math.ceil(contextTokens * 0.02));
  const extraOutput = ["max_completion_tokens", "max_tokens", "max_output_tokens", "maxOutputTokens"]
    .map(key => (settings.defaults?.extra as Record<string, unknown> | undefined)?.[key])
    .find((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0);
  const outputTokens = Math.min(requestedOutputTokens ?? settings.defaults?.maxOutputTokens ?? extraOutput ?? Math.min(4096, Math.floor(contextTokens / 4)), limits.maxOutputTokens ?? Infinity);
  const inputTokens = Math.floor(Math.min(limits.maxInputTokens ?? Infinity, contextTokens - outputTokens - safetyTokens));
  if (inputTokens < 1 || !Number.isFinite(inputTokens) || outputTokens < 1) {
    throw new ModelRequestBudgetError("上下文配置无效：总容量不足以容纳输出预留和安全余量");
  }
  return { contextTokens, inputTokens, outputTokens, safetyTokens };
}

export function estimateRequestTokens(messages: LlmMessage[], tools: LlmToolDefinition[], config: AppConfig): number {
  return estimateLlmMessagesTokens(messages, config) + estimateLlmToolsTokens(tools, config) + messages.length * 4;
}

export function resolveRequestOutputBudget(context: LlmProviderRequestContext, messages: LlmMessage[], tools: LlmToolDefinition[], requested?: number): number {
  const budget = resolveModelRequestBudget(context.modelProfile, getRoutingPresetTokenLimits(context.config).contextTokens, requested, context.operation);
  const estimated = estimateRequestTokens(messages, tools, context.config);
  if (estimated > budget.inputTokens) throw new ModelRequestBudgetError(`模型 ${context.modelRef} 的估算输入 ${estimated} 超过可用输入 ${budget.inputTokens}（总上下文 ${budget.contextTokens}，输出预留 ${budget.outputTokens}，安全余量 ${budget.safetyTokens}）`);
  return budget.outputTokens;
}

export function estimateLlmMessagesTokens(messages: LlmMessage[], config: AppConfig): number {
  const weights = config.conversation.historyCompression.tokenEstimation;
  return messages.reduce((sum, message) => (
    sum
    + estimateTokens(message.role, weights)
    + estimateMessageContentTokens(message.content, weights)
    + estimateTokens(message.tool_call_id ?? "", weights)
    + estimateTokens(message.reasoning_content ?? "", weights)
    + estimateToolCallsTokens(message, config)
    + (message.providerMetadata?.openRouterReasoningDetails ? estimateTokens(JSON.stringify(message.providerMetadata.openRouterReasoningDetails), weights) : 0)
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
