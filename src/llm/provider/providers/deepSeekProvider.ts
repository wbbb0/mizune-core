import { fetchWithProxy } from "#services/proxy/index.ts";
import { dumpProviderRequest, dumpProviderResponse } from "../providerDebugDump.ts";
import { createProviderTimeoutController, rethrowProviderAbortReason } from "../providerTimeout.ts";
import {
  createProviderStreamAccumulator,
  createReportedUsage,
  extractSseDataLines,
  mergeIndexedToolCallDeltas,
  splitSseEvents
} from "../providerStreamAdapter.ts";
import {
  numberOrNull,
  type LlmContentPart,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderGenerateParams,
  type LlmProviderGenerateResult,
  type LlmProviderRequestContext,
  type LlmToolCall
} from "../providerTypes.ts";

interface DeepSeekChatCompletionChunk {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
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

interface DeepSeekRequestMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export class DeepSeekProvider implements LlmProvider {
  readonly type = "deepseek" as const;

  resolveBaseUrl(providerConfig: LlmProviderRequestContext["providerConfig"]): string | null {
    return providerConfig.baseUrl?.trim() || "https://api.deepseek.com";
  }

  async generate(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult> {
    const endpoint = `${context.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const resolvedTimeoutMs = params.timeoutMsOverride ?? context.config.llm.timeoutMs;
    const resolvedEnableThinking = params.enableThinkingOverride ?? false;
    const requestMessages = buildDeepSeekRequestMessages(params.messages);
    const requestBody: Record<string, unknown> = {
      model: context.model,
      stream: true,
      messages: requestMessages,
      stream_options: {
        include_usage: true
      },
      thinking: {
        type: resolvedEnableThinking ? "enabled" : "disabled"
      },
      ...(resolvedEnableThinking ? { reasoning_effort: "high" } : {}),
      ...((params.tools?.length ?? 0) > 0 ? { tools: params.tools } : {})
    };

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
            const payload = JSON.parse(data) as DeepSeekChatCompletionChunk;
            responseChunks.push(payload);
            if (payload.usage) {
              accumulator.replaceUsage(createReportedUsage({
                modelRef: context.modelRef,
                model: context.model,
                inputTokens: numberOrNull(payload.usage.prompt_tokens),
                outputTokens: numberOrNull(payload.usage.completion_tokens),
                totalTokens: numberOrNull(payload.usage.total_tokens),
                cachedTokens: numberOrNull(payload.usage.prompt_cache_hit_tokens) ?? 0,
                reasoningTokens: numberOrNull(payload.usage.completion_tokens_details?.reasoning_tokens) ?? 0
              }));
            }

            const delta = payload.choices?.[0]?.delta;
            if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) {
              timeoutController.markFirstResponseReceived();
              accumulator.appendReasoningDelta(delta.reasoning_content, params.onReasoningDelta);
            }
            if (typeof delta?.content === "string" && delta.content.length > 0) {
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
          toolCalls: Array.from(toolCalls.values()),
          usage: accumulator.usage
        });
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
    messages: buildDeepSeekRequestMessages(params.messages)
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

function buildDeepSeekRequestMessages(messages: LlmMessage[]): DeepSeekRequestMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: convertDeepSeekMessageContent(message.content),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.role === "assistant" && typeof message.reasoning_content === "string"
      ? { reasoning_content: message.reasoning_content }
      : {})
  }));
}

function convertDeepSeekMessageContent(content: LlmMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map(formatDeepSeekContentPart)
    .filter((part) => part.length > 0)
    .join("\n");
}

function formatDeepSeekContentPart(part: LlmContentPart): string {
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "image_url") {
    return `[image omitted: ${part.image_url.url.slice(0, 80)}]`;
  }
  return `[audio omitted: format=${part.input_audio.format}]`;
}
