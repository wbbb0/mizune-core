import { estimateMessageContentTokens } from "./messageContentTokens.ts";
import { estimateTokens } from "#conversation/session/tokenEstimator.ts";
import type { AppConfig } from "#config/config.ts";
import type { ModelProfile } from "#config/configModel.ts";
import type { LlmMessage, LlmToolDefinition, LlmProviderRequestContext } from "../provider/providerTypes.ts";
import { getGenerationSettings } from "../provider/generationSettings.ts";

export class ModelRequestBudgetError extends Error { }

export function getModelInputBudget(profile: ModelProfile, operation: "chat" | "transcription" = "chat"): number {
  const settings = profile[operation];
  const limits = settings?.limits;
  const defaultReserve = Math.min(4096, limits?.contextTokens ? Math.max(1, Math.floor(limits.contextTokens / 4)) : 4096);
  const output = Math.min(settings?.defaults?.maxOutputTokens ?? defaultReserve, limits?.maxOutputTokens ?? Infinity);
  return Math.max(1, Math.min(limits?.maxInputTokens ?? Infinity, (limits?.contextTokens ?? Infinity) - output));
}

export function resolveRequestOutputBudget(context: LlmProviderRequestContext, messages: LlmMessage[], tools: LlmToolDefinition[], requested?: number): number | undefined {
  const settings = getGenerationSettings(context);
  if (!settings) throw new ModelRequestBudgetError(`模型 ${context.modelRef} 未配置 ${context.operation ?? "chat"} 用途`);
  const limits = settings.limits;
  const estimated = estimateLlmMessagesTokens(messages, context.config) + estimateLlmToolsTokens(tools, context.config) + messages.length * 4;
  if (limits.maxInputTokens && estimated > limits.maxInputTokens) throw new ModelRequestBudgetError(`模型 ${context.modelRef} 的估算输入 ${estimated} 超过输入上限 ${limits.maxInputTokens}`);
  const available = limits.contextTokens ? limits.contextTokens - estimated : Infinity;
  if (available < 1) throw new ModelRequestBudgetError(`模型 ${context.modelRef} 的估算输入超过上下文上限`);
  const budget = Math.min(requested ?? settings.defaults?.maxOutputTokens ?? Infinity, limits.maxOutputTokens ?? Infinity, available);
  return Number.isFinite(budget) ? Math.floor(budget) : undefined;
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
