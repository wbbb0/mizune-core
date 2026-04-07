import { fetchWithProxy } from "#services/proxy/index.ts";
import { createProviderTimeoutController, rethrowProviderAbortReason } from "../providerTimeout.ts";
import {
  createEmptyUsage,
  numberOrNull,
  type LlmContentPart,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderGenerateParams,
  type LlmProviderGenerateResult,
  type LlmProviderRequestContext
} from "../providerTypes.ts";
import { OpenAiProvider } from "./openaiProvider.ts";

const DEFAULT_BASE_URL = "http://localhost:1234/v1";
const DEFAULT_API_KEY = "lm-studio";
const DEFAULT_THINKING_FEATURE = { type: "flag" as const, path: "enable_thinking" };

interface LmStudioChatResponsePayload {
  output?: Array<{
    type?: string;
    content?: string;
  }>;
  stats?: {
    input_tokens?: number;
    total_output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

type NativeLmStudioInput =
  | { type: "message"; content: string }
  | { type: "image"; data_url: string };

/**
 * LM Studio provider — OpenAI 兼容协议，内置本地默认地址与思考开关控制。
 *
 * 与 openai provider 的主要差异：
 * - baseUrl 默认为 http://localhost:1234/v1，无需显式配置
 * - apiKey 可选，缺省时使用 "lm-studio"
 * - 若模型声明 supportsThinking 且未手动配置 features.thinking，
 *   自动注入 enable_thinking 控制字段，无需额外 provider feature 配置
 * - 对少数明确 opt-in 的“无工具且需关闭思考”请求，走 LM Studio 原生 /api/v1/chat
 */
export class LmStudioProvider implements LlmProvider {
  readonly type = "lmstudio" as const;
  private readonly delegate = new OpenAiProvider();

  resolveBaseUrl(providerConfig: LlmProviderRequestContext["providerConfig"]): string | null {
    return providerConfig.baseUrl?.trim() || DEFAULT_BASE_URL;
  }

  async generate(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult> {
    const features = context.providerConfig.features;
    const defaultThinking =
      features.thinking == null && context.modelProfile.supportsThinking
        ? DEFAULT_THINKING_FEATURE
        : undefined;

    const patchedContext: LlmProviderRequestContext = {
      ...context,
      providerConfig: {
        ...context.providerConfig,
        apiKey: context.providerConfig.apiKey ?? DEFAULT_API_KEY,
        features: {
          ...features,
          ...(defaultThinking != null ? { thinking: defaultThinking } : {})
        }
      }
    };

    if (shouldUseNativeNoThinkingChatEndpoint(patchedContext, params)) {
      return this.generateWithNativeChatEndpoint(patchedContext, params);
    }

    return this.delegate.generate(patchedContext, params);
  }

  private async generateWithNativeChatEndpoint(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult> {
    const endpoint = `${context.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "")}/api/v1/chat`;
    const resolvedTimeoutMs = params.timeoutMsOverride ?? context.config.llm.timeoutMs;
    const requestBody = buildNativeChatRequestBody(context.model, params.messages);
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
        throw new Error(`LLM API error: ${response.status} ${response.statusText}${errorText ? ` ${errorText}` : ""}`);
      }

      const payload = await response.json() as LmStudioChatResponsePayload;
      const text = extractNativeChatText(payload);
      const reasoningContent = extractNativeReasoningContent(payload);
      const usage = payload.stats
        ? {
            inputTokens: numberOrNull(payload.stats.input_tokens),
            outputTokens: numberOrNull(payload.stats.total_output_tokens),
            totalTokens: sumNullable(
              numberOrNull(payload.stats.input_tokens),
              numberOrNull(payload.stats.total_output_tokens)
            ),
            cachedTokens: null,
            reasoningTokens: numberOrNull(payload.stats.reasoning_output_tokens),
            requestCount: 1,
            providerReported: true,
            modelRef: context.modelRef,
            model: context.model
          }
        : (() => {
            const fallbackUsage = createEmptyUsage(context.modelRef, context.model);
            fallbackUsage.requestCount = 1;
            return fallbackUsage;
          })();

      if (params.onTextDelta && text.length > 0) {
        await params.onTextDelta(text);
      }

      if (!text.trim()) {
        throw new Error("LLM returned empty content");
      }

      return {
        text: text.trim(),
        reasoningContent,
        toolCalls: [],
        usage
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

function shouldUseNativeNoThinkingChatEndpoint(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams
): boolean {
  if (!params.preferNativeNoThinkingChatEndpoint) {
    return false;
  }
  if ((params.enableThinkingOverride ?? false) !== false) {
    return false;
  }
  if ((params.tools?.length ?? 0) > 0) {
    return false;
  }
  return canMapMessagesToNativeChatInput(params.messages);
}

function canMapMessagesToNativeChatInput(messages: LlmMessage[]): boolean {
  if (messages.length === 0) {
    return false;
  }

  for (const message of messages) {
    if (message.role !== "system" && message.role !== "user") {
      return false;
    }
    if (message.tool_call_id || message.tool_calls || message.reasoning_content) {
      return false;
    }
    if (typeof message.content === "string") {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "text" && part.type !== "image_url") {
        return false;
      }
    }
  }

  return true;
}

function buildNativeChatRequestBody(model: string, messages: LlmMessage[]): Record<string, unknown> {
  const systemPrompts: string[] = [];
  const input: NativeLmStudioInput[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const systemText = flattenMessageText(message);
      if (systemText) {
        systemPrompts.push(systemText);
      }
      continue;
    }

    if (typeof message.content === "string") {
      input.push({
        type: "message",
        content: message.content
      });
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text.length > 0) {
          input.push({
            type: "message",
            content: part.text
          });
        }
        continue;
      }

      if (part.type === "image_url") {
        input.push({
          type: "image",
          data_url: part.image_url.url
        });
      }
    }
  }

  return {
    model,
    input,
    reasoning: "off",
    stream: false,
    store: false,
    ...(systemPrompts.length > 0 ? { system_prompt: systemPrompts.join("\n\n") } : {})
  };
}

function flattenMessageText(message: LlmMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((part): part is Extract<LlmContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function extractNativeChatText(payload: LmStudioChatResponsePayload): string {
  return (payload.output ?? [])
    .filter((item) => item.type === "message" && typeof item.content === "string")
    .map((item) => item.content ?? "")
    .join("");
}

function extractNativeReasoningContent(payload: LmStudioChatResponsePayload): string {
  return (payload.output ?? [])
    .filter((item) => item.type === "reasoning" && typeof item.content === "string")
    .map((item) => item.content ?? "")
    .join("");
}

function sumNullable(left: number | null, right: number | null): number | null {
  if (left == null && right == null) {
    return null;
  }
  return (left ?? 0) + (right ?? 0);
}
