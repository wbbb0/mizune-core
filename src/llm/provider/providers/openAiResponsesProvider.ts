import { dumpProviderRequest, dumpProviderResponse } from "../providerDebugDump.ts";
import { buildOpenAiResponsesModelApiParameters } from "../modelApiParameters.ts";
import { getNativeSearchEnableKey } from "../nativeSearch.ts";
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

export class OpenAiResponsesProvider implements LlmProvider {
  readonly type = "openai_responses" as const;

  resolveBaseUrl(providerConfig: LlmProviderRequestContext["providerConfig"]): string | null {
    return providerConfig.baseUrl?.trim() || "https://api.openai.com/v1";
  }

  async generate(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult> {
    const endpoint = `${context.baseUrl.replace(/\/$/, "")}/responses`;
    const resolvedEnableThinking = params.enableThinkingOverride ?? false;
    const requestInput = buildOpenAiResponsesInput(params.messages);
    const requestBody = buildOpenAiResponsesRequestBody(context, params, requestInput, resolvedEnableThinking);
    const responseEvents: unknown[] = [];

    if (context.config.llm.debugDump.enabled && !params.skipDebugDump) {
      await dumpProviderRequest(context, {
        endpoint,
        requestBody,
        messages: requestInput
      });
    }

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
          responseEvents.push(payload);
          return parseOpenAiResponsesStreamPayload(context, payload);
        }
      });

      const response = stream.finalPayload;
      if (!response) {
        throw new Error("OpenAI Responses stream ended without response.completed");
      }

      const finalText = stream.accumulator.text.trim() || extractResponseText(response.output);
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

      if (context.config.llm.debugDump.enabled && !params.skipDebugDump) {
        await dumpProviderResponse(context, {
          model: context.model,
          enableThinking: resolvedEnableThinking,
          events: responseEvents,
          response,
          finalText,
          reasoningContent,
          toolCalls
        });
      }

      return {
        text: finalText,
        reasoningContent,
        toolCalls,
        usage: stream.accumulator.usage,
        assistantMetadata: {
          openAiResponses: {
            outputItems: structuredClone(response.output ?? [])
          }
        }
      };
    } catch (error) {
      if (context.config.llm.debugDump.enabled && !params.skipDebugDump) {
        await dumpProviderResponse(context, {
          model: context.model,
          enableThinking: resolvedEnableThinking,
          events: responseEvents,
          error: serializeError(error)
        });
      }
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
    model: context.model,
    stream: true,
    ...buildOpenAiResponsesModelApiParameters(context),
    input,
    tools: buildOpenAiResponsesTools(context, params.tools ?? []),
    store: false
  };

  if ((requestBody.tools as unknown[]).length === 0) {
    delete requestBody.tools;
  }

  const thinkingFeature = getProviderFeatureFromContext(context, "thinking");
  if (thinkingFeature?.type === "flag") {
    setPropertyByPath(requestBody, thinkingFeature.path, enableThinking);
  } else if (
    enableThinking
    && context.modelProfile.supportsThinking
  ) {
    const configuredReasoning = isRecord(requestBody.reasoning) ? requestBody.reasoning : {};
    requestBody.reasoning = {
      summary: "auto",
      ...configuredReasoning
    };
  } else if (
    !enableThinking
    && context.modelProfile.supportsThinking
    && context.modelProfile.thinkingControllable
  ) {
    const configuredReasoning = isRecord(requestBody.reasoning) ? requestBody.reasoning : {};
    requestBody.reasoning = {
      ...configuredReasoning,
      effort: "none"
    };
  }

  const nativeSearchEnableKey = getNativeSearchEnableKey(context.config, context.modelRef);
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

function buildOpenAiResponsesInput(messages: LlmMessage[]): unknown[] {
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
      const replayItems = getOpenAiResponsesReplayItems(message);
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

function getOpenAiResponsesReplayItems(message: LlmMessage): unknown[] | null {
  const metadata = message.providerMetadata?.openAiResponses;
  if (!isRecord(metadata) || !Array.isArray(metadata.outputItems)) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeError(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}
