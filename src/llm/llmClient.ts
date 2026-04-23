import type { AppConfig } from "#config/config.ts";
import { getPrimaryModelProfile, normalizeModelRefs } from "#llm/shared/modelProfiles.ts";
import { getModelRefsForRole } from "#llm/shared/modelRouting.ts";
import type { Logger } from "pino";
import { getLlmProvider, hasLlmProvider } from "./provider/providerRegistry.ts";
import {
  createEmptyUsage,
  mergeUsage,
  type LlmFallbackEvent,
  type LlmGenerateParams,
  type LlmGenerateResult,
  type LlmMessage,
  type LlmProviderRequestContext,
  type LlmToolCall,
  type LlmToolExecutionResult,
  type LlmUsage
} from "./provider/providerTypes.ts";
import { extractToolError, parseToolArguments } from "./shared/toolArgs.ts";

export type {
  LlmContentPart,
  LlmFallbackEvent,
  LlmGenerateParams,
  LlmGenerateResult,
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
  LlmToolExecutionResult,
  LlmUsage
} from "./provider/providerTypes.ts";

export class LlmClient {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) { }

  isConfigured(modelRef: string | string[] = getModelRefsForRole(this.config, "main_small")): boolean {
    return this.config.llm.enabled && this.resolveProviderContexts(modelRef).length > 0;
  }

  async generate(params: LlmGenerateParams): Promise<LlmGenerateResult> {
    return this.runWithTools(params);
  }

  private async runWithTools(params: LlmGenerateParams): Promise<LlmGenerateResult> {
    const requestedModelRefs = normalizeModelRefs(params.modelRefOverride ?? getModelRefsForRole(this.config, "main_small"));
    let activeModelRefs = [...requestedModelRefs];
    const resolvedModelProfile = getPrimaryModelProfile(this.config, requestedModelRefs);
    const preserveThinking = resolvedModelProfile?.preserveThinking ?? false;
    const workingMessages = cloneMessagesForRequest(
      params.messages,
      preserveThinking
    );
    const maxIterations = this.config.llm.toolCallMaxIterations;
    const aggregatedUsage: LlmUsage = createEmptyUsage(requestedModelRefs[0] ?? null, null);
    let lastReasoningContent = "";
    const consumeClonedSteerMessages = async (): Promise<LlmMessage[]> => {
      const steerMessages = await params.consumeSteerMessages?.() ?? [];
      return steerMessages.length > 0
        ? cloneMessagesForRequest(
            steerMessages,
            preserveThinking
          )
        : [];
    };

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const steerMessages = await consumeClonedSteerMessages();
      if (steerMessages.length > 0) {
        workingMessages.push(...steerMessages);
      }

      const tools = typeof params.tools === "function"
        ? params.tools()
        : (params.tools ?? []);
      const streamed = await this.streamChatCompletion({
        messages: workingMessages,
        tools,
        ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
        ...(params.onTextDelta ? { onTextDelta: params.onTextDelta } : {}),
        ...(params.onReasoningDelta ? { onReasoningDelta: params.onReasoningDelta } : {}),
        ...(params.toolExecutor ? { toolExecutor: params.toolExecutor } : {}),
        ...(params.onFallbackEvent ? { onFallbackEvent: params.onFallbackEvent } : {}),
        ...(params.modelOverride ? { modelOverride: params.modelOverride } : {}),
        modelRefOverride: activeModelRefs,
        ...(params.timeoutMsOverride ? { timeoutMsOverride: params.timeoutMsOverride } : {}),
        ...(params.enableThinkingOverride != null ? { enableThinkingOverride: params.enableThinkingOverride } : {}),
        ...(params.preferNativeNoThinkingChatEndpoint != null
          ? { preferNativeNoThinkingChatEndpoint: params.preferNativeNoThinkingChatEndpoint }
          : {}),
        ...(params.skipDebugDump ? { skipDebugDump: params.skipDebugDump } : {})
      });
      activeModelRefs = narrowActiveModelRefs(activeModelRefs, streamed.modelRef);
      mergeUsage(aggregatedUsage, streamed.usage);
      lastReasoningContent = streamed.reasoningContent;

      if (streamed.toolCalls.length === 0) {
        return {
          text: streamed.text,
          reasoningContent: lastReasoningContent,
          usage: aggregatedUsage
        };
      }

      const assistantMessage: LlmMessage = {
        role: "assistant",
        content: streamed.text,
        tool_calls: streamed.toolCalls,
        ...(streamed.assistantMetadata ? { providerMetadata: streamed.assistantMetadata } : {})
      };
      if (typeof streamed.reasoningContent === "string" && streamed.reasoningContent.length > 0) {
        assistantMessage.reasoning_content = streamed.reasoningContent;
      }
      workingMessages.push(assistantMessage);
      await params.onAssistantToolCalls?.(assistantMessage);

      for (const toolCall of streamed.toolCalls) {
        this.logger.info(
          {
            toolName: toolCall.function.name,
            toolCallId: toolCall.id,
            argumentsPreview: toolCall.function.arguments.slice(0, 300)
          },
          "tool_call_started"
        );

        let toolResult: string;
        let supplementalMessages: LlmMessage[] = [];
        let terminalResponse: { text: string } | undefined;
        try {
          const rawToolResult = params.toolExecutor
            ? await params.toolExecutor(toolCall)
            : await this.executeToolCall(toolCall);
          const normalizedToolResult = normalizeToolExecutionResult(rawToolResult);
          toolResult = normalizedToolResult.content;
          supplementalMessages = normalizedToolResult.supplementalMessages ?? [];
          terminalResponse = normalizedToolResult.terminalResponse;
        } catch (error: unknown) {
          this.logger.error(
            {
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
              argumentsPreview: toolCall.function.arguments.slice(0, 300),
              error: serializeError(error)
            },
            "tool_call_failed"
          );
          throw error;
        }

        this.logger.info(
          {
            toolName: toolCall.function.name,
            toolCallId: toolCall.id,
            resultPreview: toolResult.slice(0, 300)
          },
          "tool_call_succeeded"
        );
        const toolError = extractToolError(toolResult);
        if (toolError) {
          this.logger.warn(
            {
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
              reason: toolError
            },
            "tool_call_returned_error"
          );
        }
        if (terminalResponse) {
          this.logger.info(
            {
              toolName: toolCall.function.name,
              toolCallId: toolCall.id
            },
            "tool_call_requested_terminal_response"
          );
          return {
            text: terminalResponse.text,
            reasoningContent: lastReasoningContent,
            usage: aggregatedUsage
          };
        }
        workingMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult
        });
        await params.onToolResultMessage?.({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult
        }, toolCall.function.name);
        for (const message of cloneMessagesForRequest(
          supplementalMessages,
          true
        )) {
          workingMessages.push(message);
        }
      }
    }

    this.logger.warn(
      {
        toolCallMaxIterations: maxIterations
      },
      "tool_call_iteration_limit_reached"
    );

    const fallback = await this.streamChatCompletion({
      messages: [
        ...workingMessages,
        ...(await consumeClonedSteerMessages()),
        {
          role: "system",
          content: `你已达到工具调用轮次上限（${maxIterations}）。不要再调用任何工具。请基于现有工具结果直接回复用户；如果任务仍未完成，请简要说明已完成内容、未完成部分和下一步建议。`
        }
      ],
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      ...(params.onTextDelta ? { onTextDelta: params.onTextDelta } : {}),
      ...(params.onReasoningDelta ? { onReasoningDelta: params.onReasoningDelta } : {}),
      ...(params.onFallbackEvent ? { onFallbackEvent: params.onFallbackEvent } : {}),
      ...(params.modelOverride ? { modelOverride: params.modelOverride } : {}),
      modelRefOverride: activeModelRefs,
      ...(params.timeoutMsOverride ? { timeoutMsOverride: params.timeoutMsOverride } : {}),
      ...(params.enableThinkingOverride != null ? { enableThinkingOverride: params.enableThinkingOverride } : {}),
      ...(params.preferNativeNoThinkingChatEndpoint != null
        ? { preferNativeNoThinkingChatEndpoint: params.preferNativeNoThinkingChatEndpoint }
        : {}),
      tools: []
    });
    mergeUsage(aggregatedUsage, fallback.usage);
    return {
      text: fallback.text || `工具调用轮次已达到上限（${maxIterations}），请基于现有结果继续处理或缩小任务范围。`,
      reasoningContent: fallback.reasoningContent,
      usage: aggregatedUsage
    };
  }

  private async streamChatCompletion(params: LlmGenerateParams): Promise<{
    text: string;
    reasoningContent: string;
    toolCalls: LlmToolCall[];
    usage: LlmUsage;
    modelRef: string | null;
    assistantMetadata?: Record<string, unknown>;
  }> {
    if (!this.config.llm.enabled) {
      throw new Error("LLM 功能未启用");
    }

    const requestedModelRefs = normalizeModelRefs(params.modelRefOverride ?? getModelRefsForRole(this.config, "main_small"));
    const providerContexts = this.resolveProviderContexts(requestedModelRefs, params.modelOverride);
    if (providerContexts.length === 0) {
      throw new Error("LLM 配置不完整");
    }

    const resolvedEnableThinking = params.enableThinkingOverride ?? false;
    let lastError: unknown = null;

    for (let index = 0; index < providerContexts.length; index += 1) {
      const providerContext = providerContexts[index];
      if (!providerContext) {
        continue;
      }

      const provider = getLlmProvider(providerContext);
      const resolvedTools = typeof params.tools === "function"
        ? params.tools()
        : params.tools;

      try {
        const result = await provider.generate(providerContext, {
          messages: params.messages,
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
          ...(resolvedTools ? { tools: resolvedTools } : {}),
          ...(params.onTextDelta ? { onTextDelta: params.onTextDelta } : {}),
          ...(params.onReasoningDelta ? { onReasoningDelta: params.onReasoningDelta } : {}),
          ...(params.timeoutMsOverride ? { timeoutMsOverride: params.timeoutMsOverride } : {}),
          ...(params.enableThinkingOverride != null ? { enableThinkingOverride: params.enableThinkingOverride } : {}),
          ...(params.preferNativeNoThinkingChatEndpoint != null
            ? { preferNativeNoThinkingChatEndpoint: params.preferNativeNoThinkingChatEndpoint }
            : {}),
          ...(params.skipDebugDump ? { skipDebugDump: params.skipDebugDump } : {})
        });
        return {
          ...result,
          modelRef: providerContext.modelRef
        };
      } catch (error: unknown) {
        lastError = error;
        const shouldFallback = index < providerContexts.length - 1 && shouldFallbackToNextModel(error);
        const nextProviderContext = shouldFallback ? providerContexts[index + 1] : null;
        this.logger.warn(
          {
            modelRef: providerContext.modelRef,
            requestedModelRefs,
            candidateIndex: providerContext.candidateIndex,
            provider: providerContext.providerName,
            model: providerContext.model,
            shouldFallback,
            error: serializeError(error)
          },
          shouldFallback ? "llm_candidate_failed_fallback_next" : "llm_candidate_failed"
        );
        if (!shouldFallback) {
          throw error;
        }
        if (nextProviderContext) {
          await params.onFallbackEvent?.(buildFallbackEvent(providerContext, nextProviderContext, error));
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("LLM request failed");
  }

  private resolveProviderContexts(
    modelRef: string | string[],
    modelOverride?: string
  ): LlmProviderRequestContext[] {
    const contexts: LlmProviderRequestContext[] = [];
    const modelRefs = normalizeModelRefs(modelRef);

    for (const candidateModelRef of modelRefs) {
      const modelProfile = this.config.llm.models[candidateModelRef];
      if (!modelProfile) {
        continue;
      }

      const providerConfig = this.config.llm.providers[modelProfile.provider];
      if (!providerConfig || !hasLlmProvider(providerConfig.type)) {
        continue;
      }

      const provider = getLlmProvider({
        config: this.config,
        logger: this.logger,
        modelRef: candidateModelRef,
        model: modelOverride ?? modelProfile.model,
        baseUrl: "",
        modelProfile,
        providerName: modelProfile.provider,
        providerConfig,
        candidateIndex: contexts.length
      });
      const baseUrl = provider.resolveBaseUrl(providerConfig);
      if (!baseUrl) {
        continue;
      }

      contexts.push({
        config: this.config,
        logger: this.logger,
        modelRef: candidateModelRef,
        model: modelOverride ?? modelProfile.model,
        baseUrl,
        modelProfile,
        providerName: modelProfile.provider,
        providerConfig,
        candidateIndex: contexts.length
      });
    }

    return contexts;
  }

  private async executeToolCall(toolCall: LlmToolCall): Promise<string> {
    const args = parseToolArguments(toolCall.function.arguments, this.logger, {
      toolName: toolCall.function.name,
      toolCallId: toolCall.id
    });

    switch (toolCall.function.name) {
      case "get_current_time":
        {
          const now = new Date();
          const timezone = this.config.scheduler.defaultTimezone;
          return JSON.stringify({
            nowMs: now.getTime(),
            isoUtc: now.toISOString(),
            timezone,
            localTime: new Intl.DateTimeFormat("zh-CN", {
              timeZone: timezone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false
            }).format(now),
            weekday: new Intl.DateTimeFormat("zh-CN", {
              timeZone: timezone,
              weekday: "long"
            }).format(now)
          });
        }
      case "get_runtime_config":
        return JSON.stringify({
          appName: this.config.appName,
          model: getPrimaryModelProfile(this.config, getModelRefsForRole(this.config, "main_small"))?.model ?? null,
          modelRef: getModelRefsForRole(this.config, "main_small"),
          whitelistEnabled: this.config.whitelist.enabled
        });
      case "echo":
        return JSON.stringify({
          echo: args
        });
      default:
        return JSON.stringify({
          error: `不支持的工具：${toolCall.function.name}`
        });
    }
  }
}

function narrowActiveModelRefs(activeModelRefs: string[], selectedModelRef: string | null): string[] {
  if (!selectedModelRef) {
    return activeModelRefs;
  }

  const selectedIndex = activeModelRefs.indexOf(selectedModelRef);
  if (selectedIndex <= 0) {
    return activeModelRefs;
  }

  return activeModelRefs.slice(selectedIndex);
}

function shouldFallbackToNextModel(error: unknown): boolean {
  const message = error instanceof Error
    ? `${error.name} ${error.message}`.toLowerCase()
    : String(error).toLowerCase();
  const statusCode = extractHttpStatusCode(message);

  return (
    isRetryableHttpStatus(statusCode)
    || hasRetryableTransportHint(message)
    || hasRecoverableProviderCapabilityHint(message)
    || hasRecoverablePolicyBlockHint(message)
    || hasRecoverableRequestReplayHint(message, statusCode)
  );
}

function extractHttpStatusCode(message: string): number | null {
  const match = message.match(/\b(?:api error|llm api error|google ai studio api error)[:\s]+(\d{3})\b/);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRetryableHttpStatus(statusCode: number | null): boolean {
  return statusCode != null && [408, 409, 423, 425, 429, 500, 502, 503, 504].includes(statusCode);
}

function hasRetryableTransportHint(message: string): boolean {
  return /\b(fetch failed|timeout|timed out|temporarily unavailable|unavailable|overloaded|rate limit|too many requests|capacity|busy|service unavailable|connection reset|connection refused|socket hang up)\b/.test(message);
}

function hasRecoverableProviderCapabilityHint(message: string): boolean {
  return /\b(llm returned empty content|empty content|empty completion|no content returned|empty stream body|stream body is missing)\b/.test(message);
}

function hasRecoverablePolicyBlockHint(message: string): boolean {
  return (
    /\b(content[_\s-]?filter|moderation(?:\s+block)?|safety|policy|blocked|high risk|unsafe content)\b/.test(message)
    && /\b(block|blocked|reject|rejected|risk|unsafe|filter|safety|policy)\b/.test(message)
  );
}

function hasRecoverableRequestReplayHint(message: string, statusCode: number | null): boolean {
  if (statusCode !== 400) {
    return false;
  }

  const mentionsBadRequest = /\b(bad request|invalid_argument|invalid argument)\b/.test(message);
  if (!mentionsBadRequest) {
    return false;
  }

  return (
    hasRecoverableGoogleThoughtSignatureHint(message)
    || hasRecoverableToolReplayMetadataHint(message)
  );
}

function hasRecoverableGoogleThoughtSignatureHint(message: string): boolean {
  return (
    /\bthought[_\s-]?signature\b/.test(message)
    && /\b(function[_\s-]?call|functioncall)\b/.test(message)
    && /\b(required for tools to work|required|missing)\b/.test(message)
  );
}

function hasRecoverableToolReplayMetadataHint(message: string): boolean {
  return (
    /\b(tool|function[_\s-]?call|functioncall)\b/.test(message)
    && /\b(replay|metadata|missing|required|unsupported|incompatible)\b/.test(message)
  );
}

function normalizeToolExecutionResult(input: string | LlmToolExecutionResult): LlmToolExecutionResult {
  if (typeof input === "string") {
    return {
      content: input,
      supplementalMessages: []
    };
  }
  return {
    content: input.content,
    supplementalMessages: input.supplementalMessages ?? [],
    ...(input.terminalResponse ? { terminalResponse: input.terminalResponse } : {})
  };
}

function cloneMessagesForRequest(messages: LlmMessage[], preserveAssistantReasoning: boolean): LlmMessage[] {
  return messages.map((message) => cloneMessageForRequest(message, preserveAssistantReasoning));
}

function cloneMessageForRequest(message: LlmMessage, preserveAssistantReasoning: boolean): LlmMessage {
  return {
    role: message.role,
    content: Array.isArray(message.content) ? [...message.content] : message.content,
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls.map(cloneToolCall) } : {}),
    ...(preserveAssistantReasoning
      && message.role === "assistant"
      && typeof message.reasoning_content === "string"
      ? { reasoning_content: message.reasoning_content }
      : {}),
    ...(message.providerMetadata ? { providerMetadata: structuredClone(message.providerMetadata) } : {})
  };
}

function cloneToolCall(toolCall: LlmToolCall): LlmToolCall {
  return {
    id: toolCall.id,
    type: toolCall.type,
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments
    },
    ...(toolCall.providerMetadata ? { providerMetadata: structuredClone(toolCall.providerMetadata) } : {})
  };
}

function serializeError(error: unknown): { name?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      ...(error.name ? { name: error.name } : {}),
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {})
    };
  }

  return {
    message: String(error)
  };
}

function buildFallbackEvent(
  from: LlmProviderRequestContext,
  to: LlmProviderRequestContext,
  error: unknown
): LlmFallbackEvent {
  return {
    summary: `模型候选 ${from.modelRef} 请求失败，已切换到 ${to.modelRef}`,
    details: formatErrorDetails(error),
    fromModelRef: from.modelRef,
    toModelRef: to.modelRef,
    fromProvider: from.providerName,
    toProvider: to.providerName
  };
}

function formatErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    const parts = [
      error.name?.trim() || "",
      error.message?.trim() || ""
    ].filter((part) => part.length > 0);
    const headline = parts.join(": ");
    if (error.stack?.trim()) {
      return headline ? `${headline}\n\n${error.stack.trim()}` : error.stack.trim();
    }
    return headline || String(error);
  }
  return String(error);
}
