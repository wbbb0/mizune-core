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

type NativeLmStudioFallbackInput =
  | { type: "text"; content: string }
  | { type: "image"; data_url: string };

type NativeLmStudioLegacyInput =
  | { type: "text"; text: string }
  | { type: "image"; data_url: string };

/**
 * LM Studio provider — OpenAI 兼容协议，内置本地默认地址与思考开关控制。
 *
 * 与 openai provider 的主要差异：
 * - baseUrl 默认为 http://localhost:1234/v1，无需显式配置
 * - apiKey 可选，缺省时使用 "lm-studio"
 * - 若模型声明 supportsThinking 且未手动配置 features.thinking，
 *   自动注入 enable_thinking 控制字段，无需额外 provider feature 配置
 * - 当无 tools 且本轮要求关闭思考时，自动切换到 /api/v1/chat（reasoning: off）
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
    if (shouldUseNativeNoThinkingEndpoint(context, params)) {
      return this.generateWithNativeChatEndpoint(context, params);
    }

    const features = context.providerConfig.features;
    const defaultThinking =
      features.thinking == null
      && context.modelProfile.supportsThinking
      && context.modelProfile.thinkingControllable
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

    const normalizedMessages = normalizeMessagesForLmStudioOpenAiEndpoint(params.messages);
    const normalizedParams: LlmProviderGenerateParams = {
      ...params,
      messages: normalizedMessages
    };

    try {
      return await this.delegate.generate(patchedContext, normalizedParams);
    } catch (error) {
      if (!shouldRetryWithoutToolsForTemplateError(error, normalizedParams)) {
        throw error;
      }

      context.logger.warn(
        {
          model: context.model,
          modelRef: context.modelRef
        },
        "lmstudio_template_error_retry_without_tools"
      );

      return this.delegate.generate(patchedContext, {
        ...normalizedParams,
        tools: []
      });
    }
  }

  private async generateWithNativeChatEndpoint(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult> {
    const endpoint = `${context.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "")}/api/v1/chat`;
    const resolvedTimeoutMs = params.timeoutMsOverride ?? context.config.llm.timeoutMs;
    const timeoutController = createProviderTimeoutController({
      totalTimeoutMs: resolvedTimeoutMs,
      firstTokenTimeoutMs: context.config.llm.firstTokenTimeoutMs
    });
    const forwardAbort = () => timeoutController.controller.abort();
    params.abortSignal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      const primaryRequestBody = buildNativeChatRequestBody(context.model, params.messages);
      const textContentRequestBody = buildTextContentNativeChatRequestBody(context.model, params.messages);
      const legacyRequestBody = buildLegacyNativeChatRequestBody(context.model, params.messages);

      let payload: LmStudioChatResponsePayload;
      try {
        payload = await requestNativeChatPayload(
          context,
          endpoint,
          timeoutController.controller.signal,
          primaryRequestBody
        );
      } catch (error) {
        if (!shouldRetryWithTextContentNativeChatShape(error)) {
          throw error;
        }
        try {
          payload = await requestNativeChatPayload(
            context,
            endpoint,
            timeoutController.controller.signal,
            textContentRequestBody
          );
        } catch (fallbackError) {
          if (!shouldRetryWithLegacyNativeChatShape(fallbackError)) {
            throw fallbackError;
          }
          payload = await requestNativeChatPayload(
            context,
            endpoint,
            timeoutController.controller.signal,
            legacyRequestBody
          );
        }
      }
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

function shouldUseNativeNoThinkingEndpoint(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams
): boolean {
  const resolvedEnableThinking = params.enableThinkingOverride ?? false;
  if (resolvedEnableThinking) {
    return false;
  }
  if (!context.modelProfile.supportsThinking || !context.modelProfile.thinkingControllable) {
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

function buildTextContentNativeChatRequestBody(model: string, messages: LlmMessage[]): Record<string, unknown> {
  const systemPrompts: string[] = [];
  const input: NativeLmStudioFallbackInput[] = [];

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
        type: "text",
        content: message.content
      });
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text.length > 0) {
          input.push({
            type: "text",
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

function buildLegacyNativeChatRequestBody(model: string, messages: LlmMessage[]): Record<string, unknown> {
  const systemPrompts: string[] = [];
  const input: NativeLmStudioLegacyInput[] = [];

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
        type: "text",
        text: message.content
      });
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text.length > 0) {
          input.push({
            type: "text",
            text: part.text
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

function normalizeMessagesForLmStudioOpenAiEndpoint(messages: LlmMessage[]): LlmMessage[] {
  const normalized = messages.map((message) => {
    if (typeof message.content === "string") {
      return {
        ...message,
        content: stripStructuredBracketOnlyLines(message.content)
      };
    }

    if (!message.content.every((part) => part.type === "text")) {
      return message;
    }

    return {
      ...message,
      content: stripStructuredBracketOnlyLines(message.content.map((part) => part.text).join("\n"))
    };
  });

  return ensureFirstNonSystemMessageIsUser(normalized);
}

function stripStructuredBracketOnlyLines(text: string): string {
  return text.replace(/^\s*⟦[^⟧]*⟧\s*(?:\r?\n)?/gm, "");
}

function ensureFirstNonSystemMessageIsUser(messages: LlmMessage[]): LlmMessage[] {
  let systemEnd = 0;
  while (systemEnd < messages.length && messages[systemEnd]?.role === "system") {
    systemEnd += 1;
  }

  const suffix = messages.slice(systemEnd);
  if (suffix.length === 0) {
    return messages;
  }
  if (suffix[0]?.role === "user") {
    return messages;
  }

  return [
    ...messages.slice(0, systemEnd),
    {
      role: "user",
      content: "⟦placeholder kind=\"bootstrap_user\" note=\"ignore_this_placeholder\"⟧"
    },
    ...suffix
  ];
}

function shouldRetryWithoutToolsForTemplateError(error: unknown, params: LlmProviderGenerateParams): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if ((params.tools?.length ?? 0) === 0) {
    return false;
  }
  return error.message.includes("No user query found in messages");
}

function extractNativeChatText(payload: LmStudioChatResponsePayload): string {
  return (payload.output ?? [])
    .filter((item) => (item.type === "message" || item.type === "text") && typeof item.content === "string")
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

async function requestNativeChatPayload(
  context: LlmProviderRequestContext,
  endpoint: string,
  signal: AbortSignal,
  requestBody: Record<string, unknown>
): Promise<LmStudioChatResponsePayload> {
  const response = await fetchWithProxy(context.config, "llm", endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${context.providerConfig.apiKey ?? ""}`
    },
    body: JSON.stringify(requestBody),
    signal
  }, {
    modelRef: context.modelRef
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error: ${response.status} ${response.statusText}${errorText ? ` ${errorText}` : ""}`);
  }

  return response.json() as Promise<LmStudioChatResponsePayload>;
}

function shouldRetryWithTextContentNativeChatShape(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return message.includes("Invalid discriminator value. Expected 'text' | 'image'");
}

function shouldRetryWithLegacyNativeChatShape(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return message.includes("'input.0.text' is required")
    || message.includes("Unrecognized key(s) in object: 'content'");
}
