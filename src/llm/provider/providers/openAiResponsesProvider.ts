import { requestOpenAiDecision } from "../openAiNativeDecision.ts";
import { getGenerationSettings } from "../generationSettings.ts";

import { buildOpenAiResponsesModelApiParameters } from "../modelApiParameters.ts";
import { getNativeSearchEnableKeyFromContext } from "../nativeSearch.ts";
import { getProviderFeatureFromContext } from "../providerFeatures.ts";
import { requestOpenAiCompatibleEmbeddings } from "../openAiCompatEmbedding.ts";
import { setPropertyByPath } from "../requestShaping.ts";
import { createReportedUsage } from "../providerStreamAdapter.ts";
import { runProviderSseStream, type ProviderSseSemanticEvent } from "../providerStreamRunner.ts";
import {
  numberOrNull,
  type LlmContentPart,
  type LlmEmbeddingParams,
  type LlmEmbeddingResult,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderGenerateParams,
  type LlmProviderGenerateResult,
  type LlmProviderRequestContext,
  type LlmToolCall,
  type LlmToolDefinition
} from "../providerTypes.ts";

interface OpenAiResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
}

interface OpenAiResponseObject {
  id?: string;
  status?: string;
  output?: unknown[];
  usage?: OpenAiResponsesUsage;
  error?: {
    code?: string;
    message?: string;
  } | null;
  incomplete_details?: {
    reason?: string;
  } | null;
}

interface OpenAiResponsesStreamPayload {
  type?: string;
  delta?: string;
  code?: string;
  message?: string;
  param?: string | null;
  item?: {
    type?: string;
  };
  response?: OpenAiResponseObject;
  error?: {
    code?: string;
    message?: string;
  };
}

export abstract class OpenAiResponsesProvider implements LlmProvider {
  abstract readonly type: "openai" | "openai_responses_compatible";
  readonly supportsStructuredOutput = true;

  resolveBaseUrl(providerConfig: LlmProviderRequestContext["providerConfig"]): string | null {
    return providerConfig.baseUrl?.trim() || "https://api.openai.com/v1";
  }

  async generate(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult> {
    params.abortSignal?.throwIfAborted();
    const endpoint = `${context.baseUrl.replace(/\/+$/, "")}/responses`;
    const resolvedEnableThinking = params.enableThinkingOverride ?? false;
    const requestInput = buildOpenAiResponsesInput(context, params.messages);
    const requestBody = buildOpenAiResponsesRequestBody(context, params, requestInput, resolvedEnableThinking);

    try {
      const stream = await runProviderSseStream<OpenAiResponseObject>({
        context,
        params,
        endpoint,
        requestBody,
        resolvedTimeoutMs: params.timeoutMsOverride ?? context.config.llm.timeoutMs,
        errorPrefix: "OpenAI Responses API error",
        parseData: (data) => {
          const payload = JSON.parse(data) as OpenAiResponsesStreamPayload;
          return parseOpenAiResponsesStreamPayload(context, payload);
        }
      });

      const response = stream.finalPayload;
      if (!response) {
        throw new Error("OpenAI Responses stream ended without response.completed");
      }

      const finalText = extractResponseText(response.output) || stream.accumulator.text.trim();
      const reasoningContent = stream.accumulator.reasoningContent || extractReasoningSummary(response.output);
      const toolCalls = extractFunctionCalls(response.output);
      if (!finalText && toolCalls.length === 0) {
        throw new Error("LLM returned empty content");
      }
      if (!resolvedEnableThinking && reasoningContent.length > 0) {
        context.logger.warn(
          {
            model: context.model,
            reason: "reasoning summary received while thinking disabled"
          },
          "llm_thinking_disable_ignored"
        );
      }

      return {
        text: finalText,
        reasoningContent,
        toolCalls,
        usage: stream.accumulator.usage,
        completionStatus: response.status === "incomplete"
          ? "truncated"
          : response.status === "completed"
            ? "completed"
            : "unknown",
        assistantMetadata: {
          openAiResponses: {
            provider: context.providerName,
            providerType: context.providerConfig.type,
            baseUrl: normalizeResponsesBaseUrl(context.baseUrl),
            model: context.model,
            responseId: response.id,
            outputItems: structuredClone(response.output ?? [])
          },
          citations: extractResponseCitations(response.output),
          searchSources: extractSearchSources(response.output)
        }
      };
    } catch (error) {
      const details = serializeError(error);
      context.logger.error({ error: details }, "llm_request_failed");
      throw error;
    }
  }

  async embed(
    context: LlmProviderRequestContext,
    params: LlmEmbeddingParams
  ): Promise<LlmEmbeddingResult> {
    return requestOpenAiCompatibleEmbeddings(context, params);
  }
}

function buildOpenAiResponsesRequestBody(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams,
  input: unknown[],
  enableThinking: boolean
): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    ...buildOpenAiResponsesModelApiParameters(context),
    model: context.model,
    stream: true,
    ...(params.maxOutputTokensOverride ? { max_output_tokens: params.maxOutputTokensOverride } : {}),
    input,
    tools: buildOpenAiResponsesTools(context, params.tools ?? []),
    store: false
  };

  if ((requestBody.tools as unknown[]).length === 0) {
    delete requestBody.tools;
  }

  if (params.responseFormat) {
    requestBody.text = {
      ...(isRecord(requestBody.text) ? requestBody.text : {}),
      format: {
        ...params.responseFormat,
        ...(params.responseFormat.type === "json_schema" ? { strict: params.responseFormat.strict ?? true } : {})
      }
    };
  }

  // Local history owns the conversation. Request opaque reasoning and search sources
  // explicitly, and never let advanced parameters introduce a second state chain.
  delete requestBody.previous_response_id;
  delete requestBody.conversation;
  delete requestBody.background;
  if (context.providerConfig.type === "openai") {
    const include = Array.isArray(requestBody.include) ? requestBody.include : [];
    requestBody.include = [...new Set([
      ...include,
      ...(getGenerationSettings(context)?.capabilities.supportsThinking ? ["reasoning.encrypted_content"] : []),
      ...(getProviderFeatureFromContext(context, "search") ? ["web_search_call.action.sources"] : [])
    ])];
    if ((requestBody.include as unknown[]).length === 0) delete requestBody.include;
  }

  const thinkingFeature = getProviderFeatureFromContext(context, "thinking");
  if (thinkingFeature?.type === "flag") {
    setPropertyByPath(requestBody, thinkingFeature.path, enableThinking);
  } else if (
    enableThinking
    && getGenerationSettings(context)?.capabilities.supportsThinking
  ) {
    const configuredReasoning = isRecord(requestBody.reasoning) ? requestBody.reasoning : {};
    requestBody.reasoning = {
      summary: "auto",
      ...configuredReasoning
    };
  } else if (
    !enableThinking
    && getGenerationSettings(context)?.capabilities.supportsThinking
    && getGenerationSettings(context)?.capabilities.thinkingControllable
  ) {
    const configuredReasoning = isRecord(requestBody.reasoning) ? requestBody.reasoning : {};
    requestBody.reasoning = {
      ...configuredReasoning,
      effort: "none"
    };
  }

  const nativeSearchEnableKey = getNativeSearchEnableKeyFromContext(context);
  if (nativeSearchEnableKey) {
    setPropertyByPath(requestBody, nativeSearchEnableKey, true);
  }

  return requestBody;
}

function buildOpenAiResponsesTools(
  context: LlmProviderRequestContext,
  functionTools: LlmToolDefinition[]
): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = functionTools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false
  }));
  const searchFeature = getProviderFeatureFromContext(context, "search");
  if (searchFeature?.type === "builtin_tool") {
    tools.push(searchFeature.tool);
  }
  return tools;
}

function buildOpenAiResponsesInput(context: LlmProviderRequestContext, messages: LlmMessage[]): unknown[] {
  const input: unknown[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id) {
        throw new Error("OpenAI Responses tool result is missing tool_call_id");
      }
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: contentAsText(message.content)
      });
      continue;
    }

    if (message.role === "assistant") {
      const replayItems = getOpenAiResponsesReplayItems(context, message);
      if (replayItems) {
        input.push(...replayItems);
        continue;
      }
      if ((message.tool_calls?.length ?? 0) > 0) {
        appendMessageItem(input, message);
        for (const toolCall of message.tool_calls ?? []) {
          input.push(convertFunctionCallToResponseItem(toolCall));
        }
        continue;
      }
    }

    if (context.providerConfig.type === "openai" && Array.isArray(message.content)
      && message.content.some(part => part.type === "input_audio")) {
      throw new Error("OpenAI 官方 Responses 不接受聊天音频输入，请使用音频转写能力。");
    }
    appendMessageItem(input, message);
  }

  return input;
}

function appendMessageItem(input: unknown[], message: LlmMessage): void {
  if (message.role === "assistant") {
    const text = contentAsText(message.content);
    if (text.length === 0) {
      return;
    }
    input.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{
        type: "output_text",
        text,
        annotations: []
      }]
    });
    return;
  }

  const content = convertMessageContent(message.content);
  if (content.length === 0) {
    return;
  }
  input.push({
    type: "message",
    role: message.role,
    content
  });
}

function convertMessageContent(content: LlmMessage["content"]): unknown[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "input_text", text: content }] : [];
  }
  return content.map(convertContentPart);
}

function convertContentPart(part: LlmContentPart): Record<string, unknown> {
  if (part.type === "text") {
    return {
      type: "input_text",
      text: part.text
    };
  }
  if (part.type === "image_url") {
    return {
      type: "input_image",
      image_url: part.image_url.url,
      detail: "auto"
    };
  }
  if (part.type === "video_url") throw new Error("当前 Responses 协议未实现原生视频输入");
  return {
    type: "input_audio",
    input_audio: {
      data: part.input_audio.data,
      format: part.input_audio.format
    }
  };
}

function contentAsText(content: LlmMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part): part is Extract<LlmContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function getOpenAiResponsesReplayItems(context: LlmProviderRequestContext, message: LlmMessage): unknown[] | null {
  const metadata = message.providerMetadata?.openAiResponses;
  if (!isRecord(metadata) || !Array.isArray(metadata.outputItems)
    || metadata.provider !== context.providerName || metadata.model !== context.model
    || metadata.providerType !== context.providerConfig.type
    || metadata.baseUrl !== normalizeResponsesBaseUrl(context.baseUrl)) {
    return null;
  }

  const expectedCallIds = new Set((message.tool_calls ?? []).map((toolCall) => toolCall.id));
  const replayCallIds = new Set(
    metadata.outputItems
      .filter(isRecord)
      .filter((item) => item.type === "function_call" && typeof item.call_id === "string")
      .map((item) => item.call_id as string)
  );
  if (expectedCallIds.size !== replayCallIds.size) {
    return null;
  }
  for (const callId of expectedCallIds) {
    if (!replayCallIds.has(callId)) {
      return null;
    }
  }
  return structuredClone(metadata.outputItems);
}

function normalizeResponsesBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  // Endpoint identity excludes credentials and normalizes host casing/default ports.
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function convertFunctionCallToResponseItem(toolCall: LlmToolCall): Record<string, unknown> {
  return {
    type: "function_call",
    call_id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments
  };
}

function parseOpenAiResponsesStreamPayload(
  context: LlmProviderRequestContext,
  payload: OpenAiResponsesStreamPayload
): ProviderSseSemanticEvent<OpenAiResponseObject>[] {
  if (payload.type === "error" || payload.type === "response.failed") {
    const error = payload.error ?? payload.response?.error;
    const code = payload.type === "error" ? payload.code : error?.code;
    const message = payload.type === "error" ? payload.message : error?.message;
    throw new Error(
      `OpenAI Responses stream error: ${code ?? "unknown"} ${message ?? ""}`.trim()
    );
  }
  if (payload.type === "response.incomplete") {
    throw new Error(
      `OpenAI Responses stream incomplete: ${payload.response?.incomplete_details?.reason ?? "unknown"}`
    );
  }
  if (payload.type === "response.output_text.delta" || payload.type === "response.refusal.delta") {
    return typeof payload.delta === "string" && payload.delta.length > 0
      ? [{ kind: "text_delta", text: payload.delta }]
      : [];
  }
  if (
    payload.type === "response.reasoning_summary_text.delta"
    || payload.type === "response.reasoning_text.delta"
  ) {
    return typeof payload.delta === "string" && payload.delta.length > 0
      ? [{ kind: "reasoning_delta", text: payload.delta }]
      : [];
  }
  if (payload.type === "response.output_item.added") {
    return [{
      kind: payload.item?.type === "function_call" ? "output_started" : "first_response"
    }];
  }
  if (
    payload.type === "response.function_call_arguments.delta"
    || payload.type === "response.function_call_arguments.done"
  ) {
    return [{ kind: "output_started" }];
  }
  if (payload.type !== "response.completed" || !payload.response) {
    return [];
  }

  const usage = payload.response.usage;
  const events: ProviderSseSemanticEvent<OpenAiResponseObject>[] = [];
  if (usage) {
    events.push({
      kind: "usage",
      usage: createReportedUsage({
        modelRef: context.modelRef,
        model: context.model,
        inputTokens: numberOrNull(usage.input_tokens),
        outputTokens: numberOrNull(usage.output_tokens),
        totalTokens: numberOrNull(usage.total_tokens),
        cachedTokens: numberOrNull(usage.input_tokens_details?.cached_tokens) ?? 0,
        reasoningTokens: numberOrNull(usage.output_tokens_details?.reasoning_tokens) ?? 0
      })
    });
  }
  events.push({ kind: "final", payload: payload.response });
  return events;
}

function extractResponseText(output: unknown[] | undefined): string {
  const texts: string[] = [];
  for (const item of output ?? []) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (!isRecord(part)) {
        continue;
      }
      if (part.type === "output_text" && typeof part.text === "string") {
        texts.push(part.text);
      } else if (part.type === "refusal" && typeof part.refusal === "string") {
        texts.push(part.refusal);
      }
    }
  }
  return texts.join("").trim();
}

function extractReasoningSummary(output: unknown[] | undefined): string {
  const summaries: string[] = [];
  for (const item of output ?? []) {
    if (!isRecord(item) || item.type !== "reasoning" || !Array.isArray(item.summary)) {
      continue;
    }
    for (const part of item.summary) {
      if (isRecord(part) && typeof part.text === "string") {
        summaries.push(part.text);
      }
    }
  }
  return summaries.join("").trim();
}

function extractFunctionCalls(output: unknown[] | undefined): LlmToolCall[] {
  const toolCalls: LlmToolCall[] = [];
  for (const item of output ?? []) {
    if (!isRecord(item) || item.type !== "function_call") {
      continue;
    }
    toolCalls.push({
      id: typeof item.call_id === "string" ? item.call_id : "",
      type: "function",
      function: {
        name: typeof item.name === "string" ? item.name : "",
        arguments: typeof item.arguments === "string" ? item.arguments : ""
      }
    });
  }
  return toolCalls;
}

interface ResponseCitation {
  url: string;
  title: string;
  startIndex?: number;
  endIndex?: number;
}

function extractResponseCitations(output: unknown[] | undefined): ResponseCitation[] {
  const citations: ResponseCitation[] = [];
  let textOffset = 0;
  let rawText = "";
  for (const item of output ?? []) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part)) continue;
      const text = part.type === "output_text" && typeof part.text === "string"
        ? part.text : part.type === "refusal" && typeof part.refusal === "string" ? part.refusal : "";
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (!isRecord(annotation) || annotation.type !== "url_citation" || !isHttpUrl(annotation.url)) continue;
        const validRange = Number.isInteger(annotation.start_index) && Number.isInteger(annotation.end_index)
          && Number(annotation.start_index) >= 0 && Number(annotation.end_index) >= Number(annotation.start_index)
          && Number(annotation.end_index) <= text.length;
        citations.push({
          url: annotation.url,
          title: typeof annotation.title === "string" ? annotation.title : annotation.url,
          ...(validRange ? {
            startIndex: textOffset + Number(annotation.start_index),
            endIndex: textOffset + Number(annotation.end_index)
          } : {})
        });
      }
      textOffset += text.length;
      rawText += text;
    }
  }
  const leadingWhitespace = rawText.length - rawText.trimStart().length;
  return citations.map(citation => citation.startIndex === undefined ? citation : {
    ...citation,
    startIndex: Math.max(0, citation.startIndex - leadingWhitespace),
    endIndex: Math.max(0, citation.endIndex! - leadingWhitespace)
  });
}

function extractSearchSources(output: unknown[] | undefined): Array<{ url: string; title: string }> {
  const sources = new Map<string, { url: string; title: string }>();
  for (const item of output ?? []) {
    if (!isRecord(item) || item.type !== "web_search_call" || !isRecord(item.action)) continue;
    for (const source of Array.isArray(item.action.sources) ? item.action.sources : []) {
      if (!isRecord(source) || !isHttpUrl(source.url)) continue;
      sources.set(source.url, { url: source.url, title: typeof source.title === "string" ? source.title : source.url });
    }
  }
  return [...sources.values()];
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeError(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}

/** Third-party Responses-compatible endpoints share the wire protocol only. */
export class OpenAiResponsesCompatibleProvider extends OpenAiResponsesProvider {
  decide: NonNullable<LlmProvider["decide"]> = (context, params) => requestOpenAiDecision(context, params);
  readonly type = "openai_responses_compatible" as const;
}
