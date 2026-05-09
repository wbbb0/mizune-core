import { buildLmStudioNativeModelApiParameters } from "../modelApiParameters.ts";
import { createReportedUsage } from "../providerStreamAdapter.ts";
import { runProviderSseStream, type ProviderSseSemanticEvent } from "../providerStreamRunner.ts";
import {
  numberOrNull,
  type LlmEmbeddingParams,
  type LlmEmbeddingResult,
  type LlmContentPart,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderGenerateParams,
  type LlmProviderGenerateResult,
  type LlmProviderRequestContext,
  type LlmUsage
} from "../providerTypes.ts";
import { OpenAiProvider } from "./openaiProvider.ts";

const DEFAULT_BASE_URL = "http://localhost:1234/v1";
const DEFAULT_API_KEY = "lm-studio";
const DEFAULT_THINKING_FEATURE = { type: "flag" as const, path: "enable_thinking" };

interface LmStudioChatResponsePayload {
  model_instance_id?: string;
  output?: Array<{
    type?: string;
    content?: string;
  }>;
  stats?: {
    input_tokens?: number;
    total_output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  response_id?: string;
}

interface LmStudioChatStreamPayload {
  type?: string;
  content?: string;
  result?: LmStudioChatResponsePayload;
  error?: {
    message?: string;
    type?: string;
    code?: string;
    param?: string;
  };
}

type NativeLmStudioInput =
  | { type: "text"; content: string }
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

  async embed(
    context: LlmProviderRequestContext,
    params: LlmEmbeddingParams
  ): Promise<LlmEmbeddingResult> {
    return this.delegate.embed({
      ...context,
      providerConfig: {
        ...context.providerConfig,
        apiKey: context.providerConfig.apiKey ?? DEFAULT_API_KEY
      }
    }, params);
  }

  private async generateWithNativeChatEndpoint(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult> {
    const endpoint = `${context.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "")}/api/v1/chat`;
    const resolvedTimeoutMs = params.timeoutMsOverride ?? context.config.llm.timeoutMs;
    try {
      const result = await requestNativeChatStream(
        context,
        params,
        endpoint,
        buildNativeChatRequestBody(context, params.messages),
        resolvedTimeoutMs
      );

      if (!result.text.trim()) {
        throw new Error("LLM returned empty content");
      }

      return {
        text: result.text.trim(),
        reasoningContent: result.reasoningContent,
        toolCalls: [],
        usage: result.usage,
        ...(result.responseId ? { assistantMetadata: { lmStudio: { responseId: result.responseId } } } : {})
      };
    } catch (error) {
      const details = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };
      context.logger.error({ error: details }, "llm_request_failed");
      throw error;
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

function buildNativeChatRequestBody(context: LlmProviderRequestContext, messages: LlmMessage[]): Record<string, unknown> {
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

  const modelApiParameters = buildLmStudioNativeModelApiParameters(context);
  return {
    model: context.model,
    input,
    ...modelApiParameters,
    reasoning: "off",
    stream: true,
    store: typeof modelApiParameters.store === "boolean" ? modelApiParameters.store : false,
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
      return message;
    }

    if (!message.content.every((part) => part.type === "text")) {
      return message;
    }

    return {
      ...message,
      content: message.content.map((part) => part.text).join("\n")
    };
  });

  return ensureFirstNonSystemMessageIsUser(normalized);
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

async function requestNativeChatStream(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams,
  endpoint: string,
  requestBody: Record<string, unknown>,
  resolvedTimeoutMs: number
): Promise<{
  text: string;
  reasoningContent: string;
  usage: LlmUsage;
  responseId?: string;
}> {
  const stream = await runProviderSseStream({
    context,
    params,
    endpoint,
    requestBody,
    resolvedTimeoutMs,
    errorPrefix: "LLM API error",
    parseData: (data) => parseNativeChatStreamData(context, data)
  });

  const finalPayload = stream.finalPayload;
  const finalText = stream.accumulator.text || (finalPayload ? extractNativeChatText(finalPayload) : "");
  const finalReasoningContent = stream.accumulator.reasoningContent
    || (finalPayload ? extractNativeReasoningContent(finalPayload) : "");
  if (stream.accumulator.text.length === 0 && finalText.length > 0) {
    await params.onTextDelta?.(finalText);
  }

  return {
    text: finalText,
    reasoningContent: finalReasoningContent,
    usage: finalPayload?.stats ? buildNativeChatUsage(context, finalPayload) : stream.accumulator.usage,
    ...(finalPayload?.response_id ? { responseId: finalPayload.response_id } : {})
  };
}

function parseNativeChatStreamData(
  context: LlmProviderRequestContext,
  data: string
): ProviderSseSemanticEvent<LmStudioChatResponsePayload>[] {
  const payload = JSON.parse(data) as LmStudioChatStreamPayload;
  if (payload.type === "error" || payload.error) {
    throw createNativeChatStreamError(payload);
  }
  if (payload.type === "reasoning.delta" && typeof payload.content === "string" && payload.content.length > 0) {
    return [{ kind: "reasoning_delta", text: payload.content }];
  }
  if (payload.type === "message.delta" && typeof payload.content === "string" && payload.content.length > 0) {
    return [{ kind: "text_delta", text: payload.content }];
  }
  if (payload.type === "chat.end" && payload.result) {
    return [
      { kind: "final", payload: payload.result },
      ...(payload.result.stats ? [{ kind: "usage" as const, usage: buildNativeChatUsage(context, payload.result) }] : [])
    ];
  }
  return [];
}

function createNativeChatStreamError(payload: LmStudioChatStreamPayload): Error {
  const error = payload.error;
  const details = [
    error?.message,
    error?.type ? `type=${error.type}` : "",
    error?.code ? `code=${error.code}` : "",
    error?.param ? `param=${error.param}` : ""
  ].filter((item) => item && item.length > 0).join("; ");
  return new Error(`LM Studio native stream error${details ? `: ${details}` : ""}`);
}

function buildNativeChatUsage(
  context: LlmProviderRequestContext,
  payload: LmStudioChatResponsePayload
): LlmUsage {
  return createReportedUsage({
    modelRef: context.modelRef,
    model: context.model,
    inputTokens: numberOrNull(payload.stats?.input_tokens),
    outputTokens: numberOrNull(payload.stats?.total_output_tokens),
    totalTokens: sumNullable(
      numberOrNull(payload.stats?.input_tokens),
      numberOrNull(payload.stats?.total_output_tokens)
    ),
    cachedTokens: null,
    reasoningTokens: numberOrNull(payload.stats?.reasoning_output_tokens)
  });
}

function sumNullable(left: number | null, right: number | null): number | null {
  if (left == null && right == null) {
    return null;
  }
  return (left ?? 0) + (right ?? 0);
}
