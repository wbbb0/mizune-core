import { getProviderFeatureFromContext } from "../providerFeatures.ts";
import { fetchWithProxy } from "#services/proxy/index.ts";
import { dumpProviderRequest, dumpProviderResponse } from "../providerDebugDump.ts";
import { createProviderTimeoutController, rethrowProviderAbortReason } from "../providerTimeout.ts";
import {
  createProviderStreamAccumulator,
  createReportedUsage,
  extractSseDataLines,
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
  type LlmToolCall,
  type LlmToolDefinition
} from "../providerTypes.ts";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const MIN_THINKING_BUDGET_TOKENS = 1024;

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicServerBlock;

interface AnthropicServerBlock {
  type: "server_tool_use" | "web_search_tool_result";
  [key: string]: unknown;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

interface AnthropicRequestMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicStreamPayload {
  type?: string;
  index?: number;
  message?: {
    usage?: AnthropicUsage;
  };
  content_block?: {
    type?: "text" | "tool_use" | "thinking" | "server_tool_use" | "web_search_tool_result";
    [key: string]: unknown;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    thinking?: string;
    signature?: string;
  };
  delta?: {
    type?: "text_delta" | "input_json_delta" | "thinking_delta" | "signature_delta";
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: AnthropicUsage;
  error?: {
    type?: string;
    message?: string;
  };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

interface AnthropicStreamBlockState {
  type: "text" | "tool_use" | "thinking" | "server_tool_use" | "web_search_tool_result";
  raw: Record<string, unknown>;
  text: string;
  id: string;
  name: string;
  inputJson: string;
  thinking: string;
  signature: string;
}

export class AnthropicMessagesProvider implements LlmProvider {
  constructor(readonly type: "anthropic" | "deepseek") {}

  resolveBaseUrl(providerConfig: LlmProviderRequestContext["providerConfig"]): string | null {
    return providerConfig.baseUrl?.trim() || (this.type === "deepseek" ? "https://api.deepseek.com/anthropic" : "https://api.anthropic.com");
  }

  async generate(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult> {
    const endpoint = `${context.baseUrl.replace(/\/$/, "")}/v1/messages`;
    const resolvedTimeoutMs = params.timeoutMsOverride ?? context.config.llm.timeoutMs;
    const resolvedEnableThinking = params.enableThinkingOverride ?? false;
    const requestMessages = buildAnthropicRequestMessages(params.messages);
    const requestBody = buildAnthropicRequestBody(context, params, requestMessages, resolvedEnableThinking);

    if (context.config.llm.debugDump.enabled && !params.skipDebugDump) {
      await dumpProviderRequest(context, {
        endpoint,
        requestBody,
        messages: requestMessages
      });
    }

    const timeoutController = createProviderTimeoutController({
      totalTimeoutMs: resolvedTimeoutMs,
      firstTokenTimeoutMs: context.config.llm.firstTokenTimeoutMs,
      thinkingTimeoutMs: context.config.llm.thinkingTimeoutMs
    });
    const forwardAbort = () => timeoutController.controller.abort();
    params.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
    if (params.abortSignal?.aborted) forwardAbort();

    try {
      const response = await fetchWithProxy(context.config, "llm", endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
          "x-api-key": context.providerConfig.apiKey ?? ""
        },
        body: JSON.stringify(requestBody),
        signal: timeoutController.controller.signal
      }, {
        modelRef: context.modelRef
      });

      if (!response.ok) {
        const errorText = await response.text();
        await dumpAnthropicFailedResponse(context, {
          endpoint,
          requestBody,
          requestMessages,
          resolvedEnableThinking,
          status: response.status,
          statusText: response.statusText,
          errorBody: errorText
        });
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText}${errorText ? ` ${errorText}` : ""}`);
      }
      if (!response.body) {
        await dumpAnthropicFailedResponse(context, {
          endpoint,
          requestBody,
          requestMessages,
          resolvedEnableThinking,
          error: "Anthropic stream body is missing"
        });
        throw new Error("Anthropic stream body is missing");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf8");
      let sseBuffer = "";
      const accumulator = createProviderStreamAccumulator({
        modelRef: context.modelRef,
        model: context.model
      });
      const blocks = new Map<number, AnthropicStreamBlockState>();
      const responseEvents: unknown[] = [];
      let stopped = false;
      let stopReason: string | undefined;
      let reportedUsage: AnthropicUsage = {};

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        sseBuffer += decoder.decode(value, { stream: true });
        const parsed = splitSseEvents(sseBuffer);
        sseBuffer = parsed.remainder;

        for (const event of parsed.events) {
          for (const data of extractSseDataLines(event)) {
            const payload = JSON.parse(data) as AnthropicStreamPayload;
            responseEvents.push(payload);
            if (payload.type === "message_stop") stopped = true;
            if (payload.type === "message_delta") stopReason = payload.delta?.stop_reason;
            reportedUsage = { ...reportedUsage, ...(payload.message?.usage ?? payload.usage) };
            if (payload.type === "error") {
              throw new Error(`Anthropic stream error: ${payload.error?.type ?? "unknown"} ${payload.error?.message ?? ""}`.trim());
            }

            mergeAnthropicUsage(context, accumulator, reportedUsage);
            const block = updateAnthropicBlock(blocks, payload);
            if (payload.type === "content_block_start") {
              timeoutController.markFirstResponseReceived();
              if (block?.type === "thinking") {
                timeoutController.markReasoningStarted();
                if (block.thinking) accumulator.appendReasoningDelta(block.thinking, params.onReasoningDelta);
              } else {
                timeoutController.markFirstTextReceived();
              }
              if (block?.type === "text" && block.text) {
                await accumulator.appendTextDelta(block.text, params.onTextDelta);
              }
            }
            if (payload.type === "content_block_delta" && block) {
              if (payload.delta?.type === "text_delta" && payload.delta.text) {
                timeoutController.markFirstResponseReceived();
                timeoutController.markFirstTextReceived();
                await accumulator.appendTextDelta(payload.delta.text, params.onTextDelta);
              }
              if (payload.delta?.type === "thinking_delta" && payload.delta.thinking) {
                timeoutController.markFirstResponseReceived();
                timeoutController.markReasoningStarted();
                accumulator.appendReasoningDelta(payload.delta.thinking, params.onReasoningDelta);
              }
              if (payload.delta?.type === "input_json_delta" && payload.delta.partial_json) {
                timeoutController.markFirstResponseReceived();
                timeoutController.markFirstTextReceived();
              }
            }
          }
        }
      }

      if (this.type === "deepseek" && (!stopped || !stopReason)) {
        throw new Error("DeepSeek 响应流未完整结束");
      }
      if (this.type === "deepseek" && stopReason !== "end_turn" && stopReason !== "tool_use" && stopReason !== "stop_sequence") {
        throw new Error(`DeepSeek 响应未完成：${stopReason}`);
      }
      const finalizedBlocks = finalizeAnthropicBlocks(blocks);
      const toolCalls = finalizedBlocks
        .filter((block): block is AnthropicToolUseBlock => block.type === "tool_use")
        .map(convertAnthropicToolUseToLlmToolCall);

      if (context.config.llm.debugDump.enabled && !params.skipDebugDump) {
        await dumpProviderResponse(context, {
          model: context.model,
          enableThinking: resolvedEnableThinking,
          sawReasoningContent: accumulator.sawReasoningContent,
          events: responseEvents,
          finalText: accumulator.text,
          reasoningContent: accumulator.reasoningContent,
          toolCalls,
          usage: accumulator.usage
        });
      }

      if (!accumulator.text.trim() && toolCalls.length === 0) {
        throw new Error("LLM returned empty content");
      }

      return {
        text: accumulator.text.trim(),
        reasoningContent: accumulator.reasoningContent,
        toolCalls,
        usage: accumulator.usage,
        assistantMetadata: {
          anthropicContentBlocks: finalizedBlocks,
          anthropicUsage: reportedUsage
        }
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

async function dumpAnthropicFailedResponse(
  context: LlmProviderRequestContext,
  payload: {
    endpoint: string;
    requestBody: unknown;
    requestMessages: unknown;
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
    messages: payload.requestMessages
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

function buildAnthropicRequestBody(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams,
  requestMessages: AnthropicRequestMessage[],
  enableThinking: boolean
): Record<string, unknown> {
  const apiParameters = buildAnthropicModelApiParameters(context);
  const maxTokens = params.maxOutputTokensOverride ?? (context.providerConfig.type === "deepseek"
    ? numberOrNull(apiParameters.max_tokens) ?? DEFAULT_MAX_TOKENS
    : resolveMaxTokens(apiParameters, enableThinking));
  const body: Record<string, unknown> = {
    model: context.model,
    stream: true,
    messages: requestMessages,
    ...apiParameters,
    max_tokens: maxTokens
  };
  const system = buildAnthropicSystem(params.messages);
  if (system) {
    body.system = system;
  }
  const tools = buildAnthropicTools(params.tools ?? []);
  const search = getProviderFeatureFromContext(context, "search");
  if (context.providerConfig.type === "deepseek" && search) {
    if (search.type !== "builtin_tool" || objectRecord(search.tool).type !== "web_search_20250305" || objectRecord(search.tool).name !== "web_search") {
      throw new Error("DeepSeek 搜索必须配置 web_search_20250305 内置工具，名称为 web_search");
    }
    tools.push(search.tool);
  }
  if (tools.length > 0) {
    body.tools = tools;
  }
  if (context.modelProfile.supportsThinking) {
    body.thinking = context.providerConfig.type === "deepseek"
      ? { type: enableThinking ? "enabled" : "disabled" }
      : buildAnthropicThinkingConfig(maxTokens, enableThinking);
    if (context.providerConfig.type === "deepseek" && enableThinking) {
      body.output_config = { ...objectRecord(body.output_config), effort: objectRecord(body.output_config).effort ?? "high" };
    }
  }
  return body;
}

function buildAnthropicModelApiParameters(context: LlmProviderRequestContext): Record<string, unknown> {
  const source = context.modelProfile.apiParameters;
  if (!source) {
    return {};
  }
  const extra = objectRecord(source.extra);
  const { thinking: _thinking, tools: _tools, tool_choice: _toolChoice, ...safeExtra } = extra;
  return {
    ...safeExtra,
    ...(source.maxOutputTokens !== undefined ? { max_tokens: source.maxOutputTokens } : {}),
    ...(source.temperature !== undefined ? { temperature: source.temperature } : {}),
    ...(source.top_p !== undefined ? { top_p: source.top_p } : {}),
    ...(source.top_k !== undefined ? { top_k: source.top_k } : {})
  };
}

function resolveMaxTokens(apiParameters: Record<string, unknown>, enableThinking: boolean): number {
  const configured = numberOrNull(apiParameters.max_tokens);
  if (!enableThinking) {
    return configured ?? DEFAULT_MAX_TOKENS;
  }
  return Math.max(configured ?? DEFAULT_MAX_TOKENS, MIN_THINKING_BUDGET_TOKENS + 1);
}

function buildAnthropicThinkingConfig(maxTokens: number, enableThinking: boolean): Record<string, unknown> {
  if (!enableThinking) {
    return { type: "disabled" };
  }
  return {
    type: "enabled",
    budget_tokens: Math.min(MIN_THINKING_BUDGET_TOKENS, maxTokens - 1)
  };
}

function buildAnthropicSystem(messages: LlmMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => contentToText(message.content))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function buildAnthropicRequestMessages(messages: LlmMessage[]): AnthropicRequestMessage[] {
  const requestMessages: AnthropicRequestMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    if (message.role === "tool") {
      pushAnthropicMessage(requestMessages, {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id ?? "",
          content: contentToText(message.content)
        }]
      });
      continue;
    }
    pushAnthropicMessage(requestMessages, {
      role: message.role,
      content: buildAnthropicMessageContent(message)
    });
  }

  return requestMessages;
}

function pushAnthropicMessage(target: AnthropicRequestMessage[], message: AnthropicRequestMessage): void {
  const previous = target[target.length - 1];
  if (
    previous
    && previous.role === message.role
    && Array.isArray(previous.content)
    && Array.isArray(message.content)
  ) {
    previous.content = [...previous.content, ...message.content];
    return;
  }
  target.push(message);
}

function buildAnthropicMessageContent(message: LlmMessage): string | AnthropicContentBlock[] {
  const replayBlocks = Array.isArray(message.providerMetadata?.anthropicContentBlocks)
    ? message.providerMetadata.anthropicContentBlocks as AnthropicContentBlock[]
    : null;
  if (message.role === "assistant" && replayBlocks && replayBlocks.length > 0) {
    return replayBlocks;
  }

  const blocks: AnthropicContentBlock[] = convertContentParts(message.content);
  if (
    message.role === "assistant"
    && typeof message.reasoning_content === "string"
    && message.reasoning_content.length > 0
  ) {
    blocks.unshift({
      type: "thinking",
      thinking: message.reasoning_content
    });
  }
  for (const toolCall of message.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input: parseJsonObject(toolCall.function.arguments)
    });
  }

  if (blocks.length === 1 && blocks[0]?.type === "text") {
    return blocks[0].text;
  }
  return blocks;
}

function convertContentParts(content: string | LlmContentPart[]): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.length > 0) {
        blocks.push({ type: "text", text: part.text });
      }
      continue;
    }
    if (part.type === "image_url") {
      blocks.push(convertImageUrlPart(part.image_url.url));
      continue;
    }
    throw new Error("Anthropic provider does not support direct audio input; configure audio transcription instead");
  }
  return blocks;
}

function convertImageUrlPart(url: string): AnthropicImageBlock {
  const parsedDataUrl = parseDataUrl(url);
  if (parsedDataUrl) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: parsedDataUrl.mediaType,
        data: parsedDataUrl.data
      }
    };
  }
  return {
    type: "image",
    source: {
      type: "url",
      url
    }
  };
}

function buildAnthropicTools(tools: LlmToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }));
}

function updateAnthropicBlock(
  blocks: Map<number, AnthropicStreamBlockState>,
  payload: AnthropicStreamPayload
): AnthropicStreamBlockState | null {
  if (payload.type === "content_block_start" && typeof payload.index === "number") {
    const contentBlock = payload.content_block;
    const initialInput = contentBlock?.input ?? {};
    const block: AnthropicStreamBlockState = {
      type: contentBlock?.type ?? "text",
      raw: { ...contentBlock },
      text: contentBlock?.text ?? "",
      id: contentBlock?.id ?? `anthropic_tool_${payload.index}`,
      name: contentBlock?.name ?? "",
      inputJson: Object.keys(initialInput).length > 0 ? JSON.stringify(initialInput) : "",
      thinking: contentBlock?.thinking ?? "",
      signature: contentBlock?.signature ?? ""
    };
    blocks.set(payload.index, block);
    return block;
  }

  if (payload.type !== "content_block_delta" || typeof payload.index !== "number") {
    return null;
  }
  const block = blocks.get(payload.index);
  if (!block) {
    return null;
  }
  if (payload.delta?.type === "text_delta") {
    block.text += payload.delta.text ?? "";
  }
  if (payload.delta?.type === "input_json_delta") {
    block.inputJson += payload.delta.partial_json ?? "";
  }
  if (payload.delta?.type === "thinking_delta") {
    block.thinking += payload.delta.thinking ?? "";
  }
  if (payload.delta?.type === "signature_delta") {
    block.signature += payload.delta.signature ?? "";
  }
  return block;
}

function finalizeAnthropicBlocks(blocks: Map<number, AnthropicStreamBlockState>): AnthropicContentBlock[] {
  return Array.from(blocks.entries())
    .sort(([left], [right]) => left - right)
    .map(([, block]): AnthropicContentBlock | null => {
      if (block.type === "server_tool_use") {
        return { ...block.raw, type: "server_tool_use", id: block.id, name: block.name, input: parseJsonObject(block.inputJson) };
      }
      if (block.type === "web_search_tool_result") {
        return { ...block.raw, type: "web_search_tool_result" };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: parseJsonObject(block.inputJson)
        };
      }
      if (block.type === "thinking") {
        return {
          type: "thinking",
          thinking: block.thinking,
          ...(block.signature ? { signature: block.signature } : {})
        };
      }
      return block.text.length > 0
        ? { ...block.raw, type: "text", text: block.text }
        : null;
    })
    .filter((block): block is AnthropicContentBlock => block != null);
}

function convertAnthropicToolUseToLlmToolCall(block: AnthropicToolUseBlock): LlmToolCall {
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input)
    }
  };
}

function mergeAnthropicUsage(
  context: LlmProviderRequestContext,
  accumulator: ReturnType<typeof createProviderStreamAccumulator>,
  usage: AnthropicUsage
): void {
  const uncachedInputTokens = numberOrNull(usage.input_tokens);
  const inputTokens = uncachedInputTokens == null ? accumulator.usage.inputTokens
    : uncachedInputTokens + (numberOrNull(usage.cache_read_input_tokens) ?? 0) + (numberOrNull(usage.cache_creation_input_tokens) ?? 0);
  const outputTokens = numberOrNull(usage.output_tokens) ?? accumulator.usage.outputTokens;
  const cachedTokens = numberOrNull(usage.cache_read_input_tokens) ?? accumulator.usage.cachedTokens ?? 0;
  accumulator.replaceUsage(createReportedUsage({
    modelRef: context.modelRef,
    model: context.model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null,
    cachedTokens,
    reasoningTokens: 0
  }));
}

function contentToText(content: string | LlmContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part): part is Extract<LlmContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/iu.exec(url);
  if (!match) {
    return null;
  }
  return {
    mediaType: match[1] ?? "application/octet-stream",
    data: match[2] ?? ""
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
