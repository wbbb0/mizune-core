import { OpenRouterReasoning } from "../openRouterReasoning.ts";
import { getGenerationSettings } from "../generationSettings.ts";
import { LlmProviderPolicyError } from "../providerProtocolError.ts";
import { readProviderSseData, throwIfProviderError } from "../providerSseReader.ts";
import { fetchProviderResponse } from "../providerExchangeDump.ts";
import { buildOpenAiCompatibleModelApiParameters } from "../modelApiParameters.ts";
import { getNativeSearchEnableKeyFromContext } from "../nativeSearch.ts";
import { getProviderFeatureFromContext } from "../providerFeatures.ts";
import { setPropertyByPath } from "../requestShaping.ts";
import { createProviderTimeoutController, rethrowProviderAbortReason } from "../providerTimeout.ts";
import { requestOpenAiCompatibleEmbeddings } from "../openAiCompatEmbedding.ts";
import {
  createEmptyUsage,
  numberOrNull,
  type LlmEmbeddingParams,
  type LlmEmbeddingResult,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderGenerateParams,
  type LlmProviderGenerateResult,
  type LlmProviderRequestContext,
  type LlmToolDefinition,
  type LlmToolCall
} from "../providerTypes.ts";
import {
  createProviderStreamAccumulator,
  createReportedUsage,
  mergeIndexedToolCallDeltas,
} from "../providerStreamAdapter.ts";

interface ChatCompletionChunkPayload {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  id?: string;
  provider?: string;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      refusal?: string;
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_details?: unknown[];
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
}

interface OpenAiRequestContentPartText {
  type: "text";
  text: string;
}

interface OpenAiRequestContentPartImageUrl {
  type: "image_url";
  image_url: {
    url: string;
  };
}

interface OpenAiRequestContentPartInputAudio {
  type: "input_audio";
  input_audio: {
    data: string;
    format: string;
  };
}

type OpenAiRequestContentPart =
  | OpenAiRequestContentPartText
  | OpenAiRequestContentPartImageUrl
  | OpenAiRequestContentPartInputAudio;

interface OpenAiRequestMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAiRequestContentPart[];
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export class OpenAiProvider implements LlmProvider {
  readonly type = "openai" as const;

  resolveBaseUrl(providerConfig: LlmProviderRequestContext["providerConfig"]): string | null {
    return providerConfig.baseUrl?.trim() || "https://api.openai.com/v1";
  }

  async generate(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult> {
    const endpoint = `${context.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const resolvedTimeoutMs = params.timeoutMsOverride ?? context.config.llm.timeoutMs;
    const resolvedEnableThinking = params.enableThinkingOverride ?? false;
    const nativeSearchEnableKey = getNativeSearchEnableKeyFromContext(context);
    const requestMessages = buildOpenAiRequestMessages(params.messages, context.providerConfig.type === "openrouter");
    const requestTools = buildOpenAiRequestTools(context, params.tools ?? []);
    const requestBody: Record<string, unknown> = {
      model: context.model,
      stream: true,
      messages: requestMessages,
      stream_options: {
        include_usage: true
      },
      ...buildOpenAiCompatibleModelApiParameters(context),

      ...(requestTools.length > 0 ? { tools: requestTools } : {})
    };

    if (params.maxOutputTokensOverride) {
      delete requestBody.max_tokens;
      delete requestBody.max_completion_tokens;
      const outputField = context.providerConfig.type === "openai" ? context.providerConfig.maxOutputTokenField : "max_tokens";
      requestBody[outputField] = params.maxOutputTokensOverride;
    }
    const thinkingFeature = getProviderFeatureFromContext(context, "thinking");
    if (thinkingFeature?.type === "flag") {
      setPropertyByPath(requestBody, thinkingFeature.path, resolvedEnableThinking);
    }
    if (shouldSendLmStudioPreserveThinking(context, params.messages, resolvedEnableThinking)) {
      requestBody.preserve_thinking = true;
    }
    if (nativeSearchEnableKey) {
      setPropertyByPath(requestBody, nativeSearchEnableKey, true);
    }

    const timeoutController = createProviderTimeoutController({
      totalTimeoutMs: resolvedTimeoutMs,
      firstTokenTimeoutMs: context.config.llm.firstTokenTimeoutMs,
      thinkingTimeoutMs: context.config.llm.thinkingTimeoutMs
    });
    const forwardAbort = () => timeoutController.controller.abort();
    params.abortSignal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      const response = await fetchProviderResponse(context.config, "llm", endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${context.providerConfig.apiKey ?? ""}`
        },
        body: JSON.stringify(requestBody),
        signal: timeoutController.controller.signal
      }, {
        modelRef: context.modelRef
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API error: ${response.status} ${response.statusText}${errorText ? ` ${errorText}` : ""}`);
      }
      if (!response.body) {
        throw new Error("LLM stream body is missing");
      }

      const accumulator = createProviderStreamAccumulator({
        modelRef: context.modelRef,
        model: context.model
      });
      const toolCalls = new Map<number, LlmToolCall>();
      const reasoning = new OpenRouterReasoning();
      let finishReason: string | null = null;
      let responseId: string | undefined;
      let upstreamProvider: string | undefined;

      for await (const data of readProviderSseData(response)) {
        const payload = JSON.parse(data) as ChatCompletionChunkPayload;
        throwIfProviderError(payload);
        responseId = payload.id ?? responseId;
        upstreamProvider = payload.provider ?? upstreamProvider;
        finishReason = payload.choices?.[0]?.finish_reason ?? finishReason;
        const refusal = payload.choices?.[0]?.delta?.refusal;
        if (refusal) throw new LlmProviderPolicyError("refusal", `LLM provider refusal: ${refusal}`);
        if (finishReason === "content_filter") throw new LlmProviderPolicyError("content_filter", "LLM provider finish_reason: content_filter");
        if (finishReason === "error") {
          throw new Error(`LLM provider finish_reason: ${finishReason}`);
        }
        if (payload.usage) {
          const cachedTokens = numberOrNull(payload.usage.prompt_tokens_details?.cached_tokens) ?? 0;
          const reasoningTokens = numberOrNull(payload.usage.completion_tokens_details?.reasoning_tokens) ?? 0;
          accumulator.replaceUsage(createReportedUsage({
            modelRef: context.modelRef,
            model: context.model,
            inputTokens: numberOrNull(payload.usage.prompt_tokens),
            outputTokens: numberOrNull(payload.usage.completion_tokens),
            totalTokens: numberOrNull(payload.usage.total_tokens),
            cachedTokens,
            reasoningTokens,
          }));
        }

        const delta = payload.choices?.[0]?.delta;
        if (context.providerConfig.type === "openrouter" && reasoning.append(delta?.reasoning_details)) {
          timeoutController.markFirstResponseReceived();
          timeoutController.markReasoningStarted();
        }
        const reasoningDelta = context.providerConfig.type === "openrouter" ? delta?.reasoning ?? delta?.reasoning_content : delta?.reasoning_content;
        if (typeof reasoningDelta === "string" && reasoningDelta) {
          timeoutController.markFirstResponseReceived();
          timeoutController.markReasoningStarted();
          accumulator.appendReasoningDelta(reasoningDelta, params.onReasoningDelta);
        }
        if (delta?.content) {
          timeoutController.markFirstResponseReceived();
          timeoutController.markFirstTextReceived();
          await accumulator.appendTextDelta(delta.content, params.onTextDelta);
        }
        if ((delta?.tool_calls?.length ?? 0) > 0) {
          timeoutController.markFirstResponseReceived();
          timeoutController.markFirstTextReceived();
        }

        mergeIndexedToolCallDeltas(toolCalls, delta?.tool_calls ?? []);
      }

      if (!resolvedEnableThinking && accumulator.sawReasoningContent) {
        context.logger.warn(
          {
            model: context.model,
            reason: "reasoning_content received while thinking disabled"
          },
          "llm_thinking_disable_ignored"
        );
      }

      if (!accumulator.text.trim() && toolCalls.size === 0) {
        throw new Error(`LLM returned empty content (finish_reason=${finishReason ?? "unknown"}, provider=${upstreamProvider ?? context.providerName}, response_id=${responseId ?? "unknown"}, output_tokens=${accumulator.usage.outputTokens ?? "unknown"})`);
      }

      return {
        text: accumulator.text.trim(),
        reasoningContent: accumulator.reasoningContent,
        toolCalls: Array.from(toolCalls.values()),
        usage: accumulator.usage,
        ...(reasoning.details.length ? { assistantMetadata: { openRouterReasoningDetails: reasoning.details } } : {})
      };
    } catch (error) {
      if (timeoutController.controller.signal.aborted) {
        rethrowProviderAbortReason(timeoutController.controller.signal, error);
      }
      const details = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };
      context.logger.error({ error: details }, "llm_request_failed");
      throw error;
    } finally {
      timeoutController.cleanup();
      params.abortSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  async embed(
    context: LlmProviderRequestContext,
    params: LlmEmbeddingParams
  ): Promise<LlmEmbeddingResult> {
    return requestOpenAiCompatibleEmbeddings(context, params);
  }
}

function buildOpenAiRequestTools(
  context: LlmProviderRequestContext,
  functionTools: LlmToolDefinition[]
): Array<Record<string, unknown>> {
  const tools = functionTools.map((tool) => tool as unknown as Record<string, unknown>);
  const searchFeature = getProviderFeatureFromContext(context, "search");
  if (searchFeature?.type === "builtin_tool") {
    tools.push(searchFeature.tool);
  }
  return tools;
}

function buildOpenAiRequestMessages(messages: LlmMessage[], openrouter = false): OpenAiRequestMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: convertOpenAiMessageContent(message),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(typeof message.reasoning_content === "string" ? openrouter ? { reasoning: message.reasoning_content } : { reasoning_content: message.reasoning_content } : {}),
    ...(openrouter && Array.isArray(message.providerMetadata?.openRouterReasoningDetails) ? { reasoning_details: message.providerMetadata.openRouterReasoningDetails } : {})
  }));
}

function convertOpenAiMessageContent(message: LlmMessage): string | OpenAiRequestContentPart[] {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (message.role === "tool") {
    return message.content
      .filter((part): part is Extract<typeof message.content[number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }

  const parts: OpenAiRequestContentPart[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text.length > 0) {
        parts.push({
          type: "text",
          text: part.text
        });
      }
      continue;
    }

    if (part.type === "image_url") {
      parts.push({
        type: "image_url",
        image_url: {
          url: part.image_url.url
        }
      });
      continue;
    }

    parts.push({
      type: "input_audio",
      input_audio: {
        data: part.input_audio.data,
        format: part.input_audio.format
      }
    });
  }

  return parts;
}

function shouldSendLmStudioPreserveThinking(
  context: LlmProviderRequestContext,
  messages: LlmMessage[],
  enableThinking: boolean
): boolean {
  if (context.providerConfig.type !== "lmstudio") {
    return false;
  }
  if (!enableThinking || getGenerationSettings(context)?.preserveThinking !== true) {
    return false;
  }

  return messages.some((message) => (
    message.role === "assistant"
    && typeof message.reasoning_content === "string"
    && message.reasoning_content.length > 0
  ));
}
