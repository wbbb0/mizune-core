import { LlmProviderBase } from "../llmProviderBase.ts";
import { buildGoogleContents, googleReplayScope } from "./googleContent.ts";
import { getGenerationSettings } from "../generationSettings.ts";
import { readProviderSseData } from "../providerSseReader.ts";
import { fetchProviderResponse } from "../providerExchangeDump.ts";
import { getProviderFeatureFromContext } from "../providerFeatures.ts";
import { buildGeminiGenerationConfigParameters } from "../modelApiParameters.ts";
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
import {
  createProviderStreamAccumulator,
  createReportedUsage,
} from "../providerStreamAdapter.ts";
import { createProviderTimeoutController, rethrowProviderAbortReason } from "../providerTimeout.ts";
import { LlmProviderPolicyError } from "../providerProtocolError.ts";

interface GoogleInlineDataPart {
  videoMetadata?: { fps: number };
  inlineData: {
    mimeType: string;
    data: string;
  };
}

interface GoogleTextPart {
  text: string;
  thought?: boolean;
  thoughtSignature?: string;
}

interface GoogleFunctionCallPart {
  thoughtSignature?: string;
  functionCall: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
}

interface GoogleFunctionResponsePart {
  functionResponse: {
    id?: string;
    name?: string;
    response?: Record<string, unknown>;
  };
}

type GooglePart = GoogleInlineDataPart | GoogleTextPart | GoogleFunctionCallPart | GoogleFunctionResponsePart;

interface GoogleStreamChunk {
  error?: {
    code?: number | string;
    message?: string;
    status?: string;
    type?: string;
    param?: string;
  };
  candidates?: Array<{
    finishReason?: string;
    content?: {
      role?: string;
      parts?: GooglePart[];
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

const GOOGLE_HARM_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT"
] as const;

// Explicit terminal failures must not be treated as missing completion metadata.
const GOOGLE_POLICY_FINISH_REASONS = new Set([
  "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
  "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"
]);
const GOOGLE_FAILED_FINISH_REASONS = new Set([
  "OTHER", "LANGUAGE", "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL",
  "TOO_MANY_TOOL_CALLS", "NO_IMAGE", "IMAGE_OTHER"
]);

export abstract class VertexGeminiProviderBase extends LlmProviderBase {
  abstract override readonly type: LlmProvider["type"];

  protected abstract readonly providerLabel: string;

  protected abstract getDefaultBaseUrl(): string | null;

  protected abstract buildStreamEndpoint(context: LlmProviderRequestContext): string;

  protected abstract buildHeaders(context: LlmProviderRequestContext): Record<string, string>;

  resolveBaseUrl(providerConfig: LlmProviderRequestContext["providerConfig"]): string | null {
    return providerConfig.baseUrl?.trim() || this.getDefaultBaseUrl();
  }

  async generate(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult> {
    const endpoint = this.buildStreamEndpoint(context);
    const requestBody = buildRequestBody(context, params);

    const resolvedTimeoutMs = params.timeoutMsOverride ?? context.config.llm.timeoutMs;
    const timeoutController = createProviderTimeoutController({
      totalTimeoutMs: resolvedTimeoutMs,
      firstTokenTimeoutMs: context.config.llm.firstTokenTimeoutMs,
      thinkingTimeoutMs: context.config.llm.thinkingTimeoutMs
    });
    const forwardAbort = () => timeoutController.controller.abort();
    params.abortSignal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      const response = await fetchProviderResponse(
        context.config,
        "llm",
        endpoint,
        {
          method: "POST",
          headers: this.buildHeaders(context),
          body: JSON.stringify(requestBody),
          signal: timeoutController.controller.signal
        },
        { modelRef: context.modelRef }
      );

      if (!response.ok) {
        throw new Error(`${this.providerLabel} API error: ${response.status} ${response.statusText} ${await response.text()}`.trim());
      }

      if (!response.body) {
        throw new Error(`${this.providerLabel} API returned an empty stream body`);
      }

      const accumulator = createProviderStreamAccumulator({
        modelRef: context.modelRef,
        model: context.model
      });
      const toolCalls = new Map<number, LlmToolCall>();
      const assistantParts: GooglePart[] = [];
      let finishReason: string | undefined;
      const processChunk = async (chunk: GoogleStreamChunk) => {
        if (chunk.error) {
          throw createGoogleStreamError(this.providerLabel, chunk.error);
        }

        if (chunk.candidates?.[0]?.finishReason) {
          const nextFinishReason = chunk.candidates[0].finishReason;
          if (finishReason && finishReason !== nextFinishReason) {
            throw new Error(`${this.providerLabel} 流终态冲突`);
          }
          finishReason = nextFinishReason;
          if (GOOGLE_POLICY_FINISH_REASONS.has(finishReason)) {
            throw new LlmProviderPolicyError("content_filter", `${this.providerLabel} finishReason: ${finishReason}`);
          }
          if (GOOGLE_FAILED_FINISH_REASONS.has(finishReason)) {
            throw new Error(`${this.providerLabel} 响应未正常完成：${finishReason}`);
          }
        }
        accumulator.replaceUsage(mergeGoogleUsage(context, chunk));
        const chunkParts = chunk.candidates?.[0]?.content?.parts ?? [];
        const newParts = chunkParts;
        for (const part of newParts) {
          assistantParts.push(part);

          if ("text" in part && typeof part.text === "string" && part.text.length > 0) {
            timeoutController.markFirstResponseReceived();
            if (part.thought) {
              timeoutController.markReasoningStarted();
              accumulator.appendReasoningDelta(part.text, params.onReasoningDelta);
            } else {
              timeoutController.markFirstTextReceived();
              await accumulator.appendTextDelta(part.text, params.onTextDelta);
            }
          }

          if ("functionCall" in part && part.functionCall?.name) {
            timeoutController.markFirstResponseReceived();
            timeoutController.markFirstTextReceived();
            const toolCall = normalizeFunctionCallPart(part, toolCalls.size);
            toolCalls.set(toolCalls.size, toolCall);
          }
        }
      };

      for await (const data of readProviderSseData(response)) {
        const chunk = JSON.parse(data) as GoogleStreamChunk;
        await processChunk(chunk);
      }

      if (!accumulator.text.trim() && toolCalls.size === 0) {
        throw new Error("LLM returned empty content");
      }

      return {
        text: accumulator.text.trim(),
        reasoningContent: accumulator.reasoningContent,
        toolCalls: Array.from(toolCalls.values()),
        usage: accumulator.usage,
        completionStatus: finishReason === "MAX_TOKENS"
          ? "truncated"
          : finishReason === "STOP"
            ? "completed"
            : "unknown",
        assistantMetadata: {
          googleParts: assistantParts,
          googleReplayScope: googleReplayScope(context)
        }
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

function buildRequestBody(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams
): Record<string, unknown> {
  const systemInstruction = buildSystemInstruction(params.messages);
  const tools = buildTools(context, params);
  const generationConfig = buildGenerationConfig(context, params);

  return {
    contents: buildGoogleContents(context, params.messages),
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    safetySettings: buildSafetySettings(context),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {})
  };
}

function buildSafetySettings(
  context: LlmProviderRequestContext
): Array<{ category: string; threshold: string }> {
  const threshold = context.providerConfig.harmBlockThreshold ?? "BLOCK_NONE";
  return GOOGLE_HARM_CATEGORIES.map((category) => ({
    category,
    threshold
  }));
}

function buildTools(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams
): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];

  if (params.tools && params.tools.length > 0) {
    tools.push({
      functionDeclarations: params.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: sanitizeGeminiSchema(tool.function.parameters)
      }))
    });
  }

  const searchFeature = getProviderFeatureFromContext(context, "search");
  if (searchFeature?.type === "builtin_tool") {
    tools.push(searchFeature.tool);
  }

  return tools;
}

function buildGenerationConfig(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    ...buildGeminiGenerationConfigParameters(context),
    ...(params.maxOutputTokensOverride ? { maxOutputTokens: params.maxOutputTokensOverride } : {})
  };

  if (getGenerationSettings(context)?.capabilities.supportsThinking) {
    generationConfig.thinkingConfig = {
      includeThoughts: params.enableThinkingOverride ?? false
    };
  }

  return generationConfig;
}

function buildSystemInstruction(messages: LlmMessage[]): { parts: GooglePart[] } | null {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => messageContentToPlainText(message.content))
    .filter((text) => text.length > 0)
    .join("\n\n");

  return systemText.length > 0
    ? { parts: [{ text: systemText }] }
    : null;
}

function normalizeFunctionCallPart(part: GoogleFunctionCallPart, ordinal: number): LlmToolCall {
  const args = part.functionCall.args ?? {};
  const thoughtSignature = typeof part.thoughtSignature === "string"
    ? part.thoughtSignature
    : "";
  return {
    id: part.functionCall.id ?? `google_tool_call_${ordinal}_${hashFunctionCall(part.functionCall.name ?? "", args)}`,
    type: "function",
    function: {
      name: part.functionCall.name ?? "unknown_function",
      arguments: JSON.stringify(args)
    },
    ...(thoughtSignature.length > 0
      ? {
          providerMetadata: {
            google: {
              thoughtSignature
            }
          }
        }
      : {})
  };
}

function normalizeFunctionResponsePayload(content: string | LlmContentPart[]): Record<string, unknown> {
  const rawText = messageContentToPlainText(content).trim();
  return { content: rawText };
}

function sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return sanitizeGeminiSchemaNode(schema) as Record<string, unknown>;
}

function sanitizeGeminiSchemaNode(value: unknown, inheritedObjectProperties?: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGeminiSchemaNode(item, inheritedObjectProperties));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const rawRecord = value as Record<string, unknown>;
  const currentProperties = isObjectRecord(rawRecord.properties)
    ? sanitizeGeminiSchemaNode(rawRecord.properties) as Record<string, unknown>
    : undefined;
  const result: Record<string, unknown> = {};
  for (const [key, rawChild] of Object.entries(rawRecord)) {
    if (key === "additionalProperties") {
      continue;
    }
    if (key === "properties" && currentProperties) {
      result[key] = currentProperties;
      continue;
    }
    if (isCompositionSchemaKey(key) && Array.isArray(rawChild)) {
      result[key] = rawChild.map((item) => sanitizeGeminiSchemaNode(item, currentProperties));
      continue;
    }
    result[key] = sanitizeGeminiSchemaNode(rawChild);
  }

  if (
    Array.isArray(result.required)
    && inheritedObjectProperties
    && !isObjectRecord(result.properties)
    && (result.type == null || result.type === "object")
  ) {
    result.type = "object";
    result.properties = inheritedObjectProperties;
  }

  if (Array.isArray(result.required)) {
    const properties = isObjectRecord(result.properties) ? result.properties : undefined;
    const required = result.required.filter((item): item is string => (
      typeof item === "string"
      && (!properties || Object.prototype.hasOwnProperty.call(properties, item))
    ));
    if (properties && result.type == null) {
      result.type = "object";
    }
    if (result.type === "object" && required.length > 0) {
      result.required = required;
    } else {
      delete result.required;
    }
  }
  return result;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isCompositionSchemaKey(key: string): boolean {
  return key === "anyOf" || key === "oneOf" || key === "allOf";
}

function mergeGoogleUsage(
  context: LlmProviderRequestContext,
  chunk: GoogleStreamChunk
) {
  const usageMetadata = chunk.usageMetadata;
  return createReportedUsage({
    modelRef: context.modelRef,
    model: context.model,
    inputTokens: numberOrNull(usageMetadata?.promptTokenCount),
    outputTokens: numberOrNull(usageMetadata?.candidatesTokenCount),
    totalTokens: numberOrNull(usageMetadata?.totalTokenCount),
    cachedTokens: usageMetadata ? (numberOrNull(usageMetadata.cachedContentTokenCount) ?? 0) : null,
    reasoningTokens: usageMetadata ? (numberOrNull(usageMetadata.thoughtsTokenCount) ?? 0) : null,
    providerReported: usageMetadata != null
  });
}

function createGoogleStreamError(
  providerLabel: string,
  error: NonNullable<GoogleStreamChunk["error"]>
): Error {
  const details = [
    error.message,
    error.status ? `status=${error.status}` : "",
    error.code != null ? `code=${error.code}` : "",
    error.type ? `type=${error.type}` : "",
    error.param ? `param=${error.param}` : ""
  ].filter(Boolean).join("; ");
  return new Error(`${providerLabel} API stream error${details ? `: ${details}` : ""}`);
}

function messageContentToPlainText(content: string | LlmContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((part): part is Extract<LlmContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (typeof parsed === "object" && parsed != null)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function hashFunctionCall(name: string, args: Record<string, unknown>): string {
  return Buffer.from(`${name}:${JSON.stringify(args)}`).toString("base64url").slice(0, 16);
}

export function buildVertexAiStreamEndpoint(rawBaseUrl: string, model: string): string {
  const sanitized = rawBaseUrl
    .replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent).*$/i, "")
    .replace(/\/$/, "");
  return `${sanitized}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

export function buildVertexExpressStreamEndpoint(rawBaseUrl: string, model: string, apiKey: string | undefined): string {
  const sanitized = rawBaseUrl
    .replace(/\/publishers\/google\/models\/[^/]+:(?:streamGenerateContent|generateContent).*$/i, "")
    .replace(/\/$/, "");
  const endpoint = `${sanitized}/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent`;
  const url = new URL(endpoint);
  url.searchParams.set("alt", "sse");
  if (apiKey?.trim()) {
    url.searchParams.set("key", apiKey.trim());
  }
  return url.toString();
}

export function formatBearerAuthorization(token: string | undefined): string {
  const trimmed = token?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}
