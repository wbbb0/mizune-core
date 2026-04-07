import { fetchWithProxy } from "#services/proxy/index.ts";
import { getNativeSearchEnableKey } from "../nativeSearch.ts";
import { getProviderFeatureFromContext } from "../providerFeatures.ts";
import { setPropertyByPath } from "../requestShaping.ts";
import { createProviderTimeoutController, rethrowProviderAbortReason } from "../providerTimeout.ts";
import {
  createProviderStreamAccumulator,
  createReportedUsage,
  extractSseDataLines,
  mergeIndexedToolCallDeltas,
  splitSseEvents
} from "../providerStreamAdapter.ts";
import {
  createEmptyUsage,
  numberOrNull,
  type LlmContentPart,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderGenerateParams,
  type LlmProviderGenerateResult,
  type LlmProviderRequestContext,
  type LlmToolCall
} from "../providerTypes.ts";

interface DashScopeStreamChunk {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  output?: {
    choices?: Array<{
      finish_reason?: string | null;
      message?: {
        role?: string;
        content?: string | Array<{ text?: string; image?: string; audio?: string }>;
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
  };
}

type DashScopeMessageContent = string | Array<{ text?: string; image?: string; audio?: string }>;

interface DashScopeRequestMessage {
  role: LlmMessage["role"];
  content: DashScopeMessageContent;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export class DashScopeProvider implements LlmProvider {
  readonly type = "dashscope" as const;

  resolveBaseUrl(providerConfig: LlmProviderRequestContext["providerConfig"]): string | null {
    return providerConfig.baseUrl?.trim() || "https://dashscope.aliyuncs.com/api/v1";
  }

  async generate(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult> {
    const endpoint = buildDashScopeEndpoint(context);
    const resolvedTimeoutMs = params.timeoutMsOverride ?? context.config.llm.timeoutMs;
    const resolvedEnableThinking = params.enableThinkingOverride ?? false;
    const requestBody = buildDashScopeRequestBody(context, params, resolvedEnableThinking);
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
          Authorization: `Bearer ${context.providerConfig.apiKey}`,
          "X-DashScope-SSE": "enable"
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

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf8");
      let sseBuffer = "";
      const accumulator = createProviderStreamAccumulator({
        modelRef: context.modelRef,
        model: context.model
      });
      const toolCalls = new Map<number, LlmToolCall>();

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
            const payload = JSON.parse(data) as DashScopeStreamChunk;
            if (payload.usage) {
              const cachedTokens = numberOrNull(payload.usage.prompt_tokens_details?.cached_tokens) ?? 0;
              const reasoningTokens = numberOrNull(payload.usage.output_tokens_details?.reasoning_tokens) ?? 0;
              accumulator.replaceUsage(createReportedUsage({
                modelRef: context.modelRef,
                model: context.model,
                inputTokens: numberOrNull(payload.usage.input_tokens),
                outputTokens: numberOrNull(payload.usage.output_tokens),
                totalTokens: numberOrNull(payload.usage.total_tokens),
                cachedTokens,
                reasoningTokens,
              }));
            }

            const message = payload.output?.choices?.[0]?.message;
            if (!message) {
              continue;
            }

            if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
              timeoutController.markFirstResponseReceived();
              accumulator.appendReasoningDelta(message.reasoning_content);
            }
            const contentDelta = extractDashScopeText(message.content);
            if (contentDelta.length > 0) {
              timeoutController.markFirstResponseReceived();
              await accumulator.appendTextDelta(contentDelta, params.onTextDelta);
            }
            if ((message.tool_calls?.length ?? 0) > 0) {
              timeoutController.markFirstResponseReceived();
            }

            mergeIndexedToolCallDeltas(toolCalls, message.tool_calls ?? []);
          }
        }
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
      throw error;
    } finally {
      timeoutController.cleanup();
      params.abortSignal?.removeEventListener("abort", forwardAbort);
    }
  }
}

function extractDashScopeText(content: string | Array<{ text?: string; image?: string; audio?: string }> | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

function buildDashScopeEndpoint(context: LlmProviderRequestContext): string {
  const trimmed = context.baseUrl.replace(/\/$/, "");
  if (/\/generation$/.test(trimmed)) {
    return trimmed;
  }
  return context.modelProfile.supportsVision
    || context.modelProfile.supportsAudioInput
    ? `${trimmed}/services/aigc/multimodal-generation/generation`
    : `${trimmed}/services/aigc/text-generation/generation`;
}

function buildDashScopeRequestBody(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams,
  enableThinking: boolean
): Record<string, unknown> {
  const requestMessages = params.messages.map((message) => convertMessageForDashScope(
    message,
    context.modelProfile.supportsVision || context.modelProfile.supportsAudioInput
  ));
  const parameters: Record<string, unknown> = {
    incremental_output: true,
    result_format: "message"
  };

  const thinkingFeature = getProviderFeatureFromContext(context, "thinking");
  if (thinkingFeature?.type === "flag") {
    setPropertyByPath(parameters, thinkingFeature.path, enableThinking);
  }
  if (params.tools && params.tools.length > 0) {
    parameters.tools = params.tools;
  }
  if (getNativeSearchEnableKey(context.config, context.modelRef)) {
    parameters.enable_search = true;
  }

  return {
    model: context.model,
    input: {
      messages: requestMessages
    },
    parameters
  };
}

function convertMessageForDashScope(message: LlmMessage, supportsMultimodal: boolean): DashScopeRequestMessage {
  return {
    role: message.role,
    content: supportsMultimodal
      ? convertVisionContent(message.content)
      : convertTextContent(message.content),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {})
  };
}

function convertTextContent(content: string | LlmContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }

  const textParts = content
    .filter((part): part is Extract<LlmContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text);
  const hasNonText = content.some((part) => part.type !== "text");
  if (hasNonText) {
    throw new Error("DashScope text-generation endpoint does not support multimodal content");
  }
  return textParts.join("\n");
}

function convertVisionContent(content: string | LlmContentPart[]): Array<{ text?: string; image?: string; audio?: string }> {
  if (typeof content === "string") {
    return content.length > 0 ? [{ text: content }] : [];
  }

  const parts: Array<{ text?: string; image?: string; audio?: string }> = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.length > 0) {
        parts.push({ text: part.text });
      }
      continue;
    }
    if (part.type === "image_url") {
      parts.push({ image: part.image_url.url });
      continue;
    }
    parts.push({
      audio: buildAudioDataUrl(part.input_audio)
    });
  }
  return parts;
}

function buildAudioDataUrl(input: { data: string; format: string; mimeType?: string }): string {
  const mimeType = input.mimeType?.trim() || inferDashScopeAudioMimeType(input.format);
  return `data:${mimeType};base64,${input.data}`;
}

function inferDashScopeAudioMimeType(format: string): string {
  const normalized = String(format).trim().toLowerCase();
  switch (normalized) {
    case "wav":
      return "audio/wav";
    case "webm":
      return "audio/webm";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "aac":
      return "audio/aac";
    case "amr":
      return "audio/amr";
    case "m4a":
    case "mp4":
      return "audio/mp4";
    default:
      return "audio/mpeg";
  }
}
