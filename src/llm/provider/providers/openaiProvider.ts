import { fetchWithProxy } from "#services/proxy/index.ts";
import { dumpProviderRequest, dumpProviderResponse } from "../providerDebugDump.ts";
import { getNativeSearchEnableKey } from "../nativeSearch.ts";
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
  extractSseDataLines,
  mergeIndexedToolCallDeltas,
  splitSseEvents
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
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
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
    const nativeSearchEnableKey = getNativeSearchEnableKey(context.config, context.modelRef);
    const requestMessages = buildOpenAiRequestMessages(params.messages);
    const requestTools = buildOpenAiRequestTools(context, params.tools ?? []);
    const requestBody: Record<string, unknown> = {
      model: context.model,
      stream: true,
      messages: requestMessages,
      stream_options: {
        include_usage: true
      },
      ...(requestTools.length > 0 ? { tools: requestTools } : {})
    };

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

    if (context.config.llm.debugDump.enabled && !params.skipDebugDump) {
      await dumpProviderRequest(context, {
        endpoint,
        requestBody,
        messages: requestMessages
      });
    }

    const timeoutController = createProviderTimeoutController({
      totalTimeoutMs: resolvedTimeoutMs,
      firstTokenTimeoutMs: context.config.llm.firstTokenTimeoutMs
    });
    const forwardAbort = () => timeoutController.controller.abort();
    params.abortSignal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      const response = await fetchWithProxy(context.config, "llm", endpoint, {
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
        await maybeDumpFailedResponse(context, params, {
          endpoint,
          requestBody,
          resolvedEnableThinking,
          status: response.status,
          statusText: response.statusText,
          errorBody: errorText
        });
        throw new Error(`LLM API error: ${response.status} ${response.statusText}${errorText ? ` ${errorText}` : ""}`);
      }
      if (!response.body) {
        await maybeDumpFailedResponse(context, params, {
          endpoint,
          requestBody,
          resolvedEnableThinking,
          error: "LLM stream body is missing"
        });
        throw new Error("LLM stream body is missing");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf8");
      let sseBuffer = "";
      const accumulator = createProviderStreamAccumulator({
        modelRef: context.modelRef,
        model: context.model
      });
      const toolCalls = new Map<number, LlmToolCall>();
      const responseChunks: unknown[] = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        sseBuffer += decoder.decode(value, { stream: true });
        const parsed = splitSseEvents(sseBuffer);
        sseBuffer = parsed.remainder;

        for (const event of parsed.events) {
          const dataLines = extractSseDataLines(event);

          for (const data of dataLines) {
            const payload = JSON.parse(data) as ChatCompletionChunkPayload;
            responseChunks.push(payload);
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
            if (typeof delta?.reasoning_content === "string") {
              timeoutController.markFirstResponseReceived();
              accumulator.appendReasoningDelta(delta.reasoning_content, params.onReasoningDelta);
            }
            if (delta?.content) {
              timeoutController.markFirstResponseReceived();
              await accumulator.appendTextDelta(delta.content, params.onTextDelta);
            }
            if ((delta?.tool_calls?.length ?? 0) > 0) {
              timeoutController.markFirstResponseReceived();
            }

            mergeIndexedToolCallDeltas(toolCalls, delta?.tool_calls ?? []);
          }
        }
      }

      if (context.config.llm.debugDump.enabled && !params.skipDebugDump) {
        await dumpProviderResponse(context, {
          model: context.model,
          enableThinking: resolvedEnableThinking,
          sawReasoningContent: accumulator.sawReasoningContent,
          chunks: responseChunks,
          finalText: accumulator.text,
          reasoningContent: accumulator.reasoningContent,
          toolCalls: Array.from(toolCalls.values())
        });
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
        throw new Error("LLM returned empty content");
      }

      return {
        text: accumulator.text.trim(),
        reasoningContent: accumulator.reasoningContent,
        toolCalls: Array.from(toolCalls.values()),
        usage: accumulator.usage
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

async function maybeDumpFailedResponse(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams,
  payload: {
    endpoint: string;
    requestBody: unknown;
    resolvedEnableThinking: boolean;
    status?: number;
    statusText?: string;
    errorBody?: string;
    error?: string;
  }
): Promise<void> {
  await dumpProviderRequest(context, {
    endpoint: payload.endpoint,
    requestBody: payload.requestBody,
    force: true,
    messages: buildOpenAiRequestMessages(params.messages)
  });
  await dumpProviderResponse(context, {
    model: context.model,
    enableThinking: payload.resolvedEnableThinking,
    endpoint: payload.endpoint,
    ...(payload.status != null ? { status: payload.status } : {}),
    ...(payload.statusText ? { statusText: payload.statusText } : {}),
    ...(payload.errorBody ? { errorBody: payload.errorBody } : {}),
    ...(payload.error ? { error: payload.error } : {})
  }, {
    force: true
  });
}

function buildOpenAiRequestMessages(messages: LlmMessage[]): OpenAiRequestMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: convertOpenAiMessageContent(message),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {})
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
  if (!enableThinking || context.modelProfile.preserveThinking !== true) {
    return false;
  }

  return messages.some((message) => (
    message.role === "assistant"
    && typeof message.reasoning_content === "string"
    && message.reasoning_content.length > 0
  ));
}
