import { fetchWithProxy } from "#services/proxy/index.ts";
import { getProviderFeatureFromContext } from "../providerFeatures.ts";
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
  extractSseDataLines,
  splitSseEvents
} from "../providerStreamAdapter.ts";
import { createProviderTimeoutController, rethrowProviderAbortReason } from "../providerTimeout.ts";

interface GoogleInlineDataPart {
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

interface GoogleContent {
  role: "user" | "model";
  parts: GooglePart[];
}

interface GoogleStreamChunk {
  candidates?: Array<{
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

export abstract class GoogleGeminiProviderBase implements LlmProvider {
  abstract readonly type: LlmProvider["type"];

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
    const resolvedTimeoutMs = params.timeoutMsOverride ?? context.config.llm.timeoutMs;
    const timeoutController = createProviderTimeoutController({
      totalTimeoutMs: resolvedTimeoutMs,
      firstTokenTimeoutMs: context.config.llm.firstTokenTimeoutMs
    });
    const forwardAbort = () => timeoutController.controller.abort();
    params.abortSignal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      const response = await fetchWithProxy(
        context.config,
        "llm",
        endpoint,
        {
          method: "POST",
          headers: this.buildHeaders(context),
          body: JSON.stringify(buildRequestBody(context, params)),
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
      const toolCalls = new Map<string, LlmToolCall>();
      const assistantParts: GooglePart[] = [];
      const assistantPartCount = new Map<string, number>();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parsed = splitSseEvents(buffer);
        buffer = parsed.remainder;

        for (const event of parsed.events) {
          for (const payload of extractSseDataLines(event)) {
            const chunk = parseChunk(payload);
            if (!chunk) {
              continue;
            }

            accumulator.replaceUsage(mergeGoogleUsage(context, chunk));
            const chunkParts = chunk.candidates?.[0]?.content?.parts ?? [];
            const newParts = collectNewParts(chunkParts, assistantPartCount);
            for (const part of newParts) {
              assistantParts.push(part);

              if ("text" in part && typeof part.text === "string" && part.text.length > 0) {
                timeoutController.markFirstResponseReceived();
                if (part.thought) {
                  accumulator.appendReasoningDelta(part.text);
                } else {
                  await accumulator.appendTextDelta(part.text, params.onTextDelta);
                }
              }

              if ("functionCall" in part && part.functionCall?.name) {
                timeoutController.markFirstResponseReceived();
                const toolCall = normalizeFunctionCallPart(part);
                toolCalls.set(toolCall.id, toolCall);
              }
            }
          }
        }
      }

      const trailing = buffer.trim();
      if (trailing.length > 0) {
        for (const line of trailing.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) {
            continue;
          }
          const chunk = parseChunk(trimmed.slice(5).trim());
          if (!chunk) {
            continue;
          }
          accumulator.replaceUsage(mergeGoogleUsage(context, chunk));
        }
      }

      if (!accumulator.text.trim() && toolCalls.size === 0) {
        throw new Error("LLM returned empty content");
      }

      return {
        text: accumulator.text.trim(),
        reasoningContent: accumulator.reasoningContent,
        toolCalls: Array.from(toolCalls.values()),
        usage: accumulator.usage,
        assistantMetadata: {
          googleParts: assistantParts
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

  protected createInlineDataError(): Error {
    return new Error(`${this.providerLabel} only supports inline image data URLs`);
  }
}

function buildRequestBody(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams
): Record<string, unknown> {
  const systemInstruction = buildSystemInstruction(params.messages);
  const tools = buildTools(context, params);
  const toolConfig = buildToolConfig(context, params, tools);
  const generationConfig = buildGenerationConfig(context, params);
  const compatibility = new ProviderCompatibilityGuards(context);
  const includeThoughts = params.enableThinkingOverride ?? false;

  return {
    contents: buildContents(params.messages, compatibility, includeThoughts),
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
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

function buildToolConfig(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams,
  tools: Array<Record<string, unknown>>
): Record<string, unknown> | null {
  const hasFunctionDeclarations = Boolean(params.tools && params.tools.length > 0);
  const hasBuiltInSearchTool = getProviderFeatureFromContext(context, "search")?.type === "builtin_tool";
  if (!hasFunctionDeclarations || !hasBuiltInSearchTool) {
    return null;
  }

  return {
    includeServerSideToolInvocations: true
  };
}

function buildGenerationConfig(
  context: LlmProviderRequestContext,
  params: LlmProviderGenerateParams
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {};

  if (context.modelProfile.supportsThinking) {
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

function buildContents(messages: LlmMessage[], compatibility: ProviderCompatibilityGuards, includeThoughts: boolean): GoogleContent[] {
  const sanitizedMessages = sanitizeMessagesForGoogleReplay(messages);
  const contents: GoogleContent[] = [];
  const toolNameById = new Map<string, string>();
  let pendingToolResponseParts: GooglePart[] = [];
  const skippedToolCallIds = new Set<string>();

  const flushPendingToolResponses = (): void => {
    if (pendingToolResponseParts.length === 0) {
      return;
    }
    contents.push({
      role: "user",
      parts: pendingToolResponseParts
    });
    pendingToolResponseParts = [];
  };

  for (const message of sanitizedMessages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "tool") {
      const toolCallId = message.tool_call_id ?? "";
      if (skippedToolCallIds.has(toolCallId)) {
        continue;
      }
      const toolName = toolNameById.get(toolCallId);
      if (!toolName) {
        throw new Error(`Missing Gemini tool call mapping for tool_call_id: ${toolCallId || "<empty>"}`);
      }
      pendingToolResponseParts.push({
        functionResponse: {
          ...(compatibility.supportsFunctionPartIds()
            ? { id: toolCallId }
            : {}),
          name: toolName,
          response: normalizeFunctionResponsePayload(message.content)
        }
      });
      continue;
    }

    flushPendingToolResponses();

    if (message.role === "assistant") {
      for (const toolCall of message.tool_calls ?? []) {
        toolNameById.set(toolCall.id, toolCall.function.name);
      }

      const rawParts = Array.isArray(message.providerMetadata?.googleParts)
        ? message.providerMetadata.googleParts as GooglePart[]
        : null;
      if (rawParts && canReplayGoogleParts(rawParts)) {
        contents.push({
          role: "model",
          parts: sanitizeGooglePartsForCompatibility(rawParts, compatibility)
        });
        continue;
      }

      const toolCalls = message.tool_calls ?? [];
      if (includeThoughts && toolCalls.length > 0) {
        // thinking 开启但缺失 thoughtSignature，无法安全 replay，静默省略该工具调用链。
        // NOTE: 如果模型在跨轮场景中频繁丢失工具调用上下文，可在 assistant visible response
        // 的 prompt 中要求模型显式复述重要工具结果，使其通过 visible history 保留关键信息。
        for (const toolCall of toolCalls) {
          skippedToolCallIds.add(toolCall.id);
        }
        continue;
      }

      // thinking 关闭，或无工具调用：直接从 tool_calls 重建，无需 thoughtSignature
      contents.push({
        role: "model",
        parts: buildAssistantParts(message, compatibility)
      });
      continue;
    }

    contents.push({
      role: "user",
      parts: convertContentToGoogleParts(message.content, compatibility)
    });
  }

  flushPendingToolResponses();
  return contents;
}

function sanitizeMessagesForGoogleReplay(messages: LlmMessage[]): LlmMessage[] {
  const sanitized: LlmMessage[] = [];
  const activeToolCallIds = new Set<string>();
  let lastReplayRole: LlmMessage["role"] | null = null;

  const clearActiveToolCalls = (): void => {
    activeToolCallIds.clear();
  };

  for (const message of messages) {
    if (message.role === "system") {
      sanitized.push(message);
      continue;
    }

    if (message.role === "user") {
      clearActiveToolCalls();
      sanitized.push(message);
      lastReplayRole = "user";
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        clearActiveToolCalls();
        sanitized.push(message);
        lastReplayRole = "assistant";
        continue;
      }

      clearActiveToolCalls();
      if (lastReplayRole !== "user" && lastReplayRole !== "tool") {
        continue;
      }

      for (const toolCall of toolCalls) {
        activeToolCallIds.add(toolCall.id);
      }
      sanitized.push(message);
      lastReplayRole = "assistant";
      continue;
    }

    const toolCallId = message.tool_call_id ?? "";
    if (
      toolCallId.length === 0
      || !activeToolCallIds.has(toolCallId)
      || (lastReplayRole !== "assistant" && lastReplayRole !== "tool")
    ) {
      continue;
    }

    sanitized.push(message);
    lastReplayRole = "tool";
  }

  return sanitized;
}

function buildAssistantParts(message: LlmMessage, compatibility: ProviderCompatibilityGuards): GooglePart[] {
  const parts = convertContentToGoogleParts(
    message.content,
    ProviderCompatibilityGuards.passThrough()
  );

  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    parts.unshift({
      text: message.reasoning_content,
      thought: true
    });
  }

  for (const toolCall of message.tool_calls ?? []) {
    const thoughtSignature = toolCall.providerMetadata?.google?.thoughtSignature;
    parts.push({
      ...(typeof thoughtSignature === "string" && thoughtSignature.length > 0
        ? { thoughtSignature }
        : {}),
      functionCall: {
        ...(compatibility.supportsFunctionPartIds()
          ? { id: toolCall.id }
          : {}),
        name: toolCall.function.name,
        args: parseJsonObject(toolCall.function.arguments)
      }
    });
  }

  return parts;
}

function convertContentToGoogleParts(
  content: string | LlmContentPart[],
  compatibility: Pick<ProviderCompatibilityGuards, "createInlineDataError">
): GooglePart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ text: content }] : [];
  }

  const parts: GooglePart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.length > 0) {
        parts.push({ text: part.text });
      }
      continue;
    }

    if (part.type === "image_url") {
      const inlineData = dataUrlToBase64(part.image_url.url);
      if (!inlineData) {
        throw compatibility.createInlineDataError();
      }
      parts.push({
        inlineData
      });
      continue;
    }

    parts.push({
      inlineData: {
        mimeType: part.input_audio.mimeType ?? inferAudioMimeType(part.input_audio.format),
        data: part.input_audio.data
      }
    });
  }

  return parts;
}

function collectNewParts(parts: GooglePart[], counters: Map<string, number>): GooglePart[] {
  const emitted: GooglePart[] = [];
  const currentCounts = new Map<string, number>();

  for (const part of parts) {
    const key = JSON.stringify(part);
    const currentCount = (currentCounts.get(key) ?? 0) + 1;
    currentCounts.set(key, currentCount);

    const seenCount = counters.get(key) ?? 0;
    if (currentCount <= seenCount) {
      continue;
    }

    counters.set(key, currentCount);
    emitted.push(part);
  }

  return emitted;
}

function sanitizeGooglePartsForCompatibility(
  parts: GooglePart[],
  compatibility: Pick<ProviderCompatibilityGuards, "supportsFunctionPartIds">
): GooglePart[] {
  if (compatibility.supportsFunctionPartIds()) {
    return parts;
  }

  return parts.map((part) => {
    if ("functionCall" in part && part.functionCall) {
      const { id: _id, ...functionCall } = part.functionCall;
      return {
        ...("thoughtSignature" in part && typeof part.thoughtSignature === "string"
          ? { thoughtSignature: part.thoughtSignature }
          : {}),
        functionCall
      };
    }
    if ("functionResponse" in part && part.functionResponse) {
      const { id: _id, ...functionResponse } = part.functionResponse;
      return { functionResponse };
    }
    return part;
  });
}

function canReplayGoogleParts(parts: GooglePart[]): boolean {
  for (const part of parts) {
    if (!("functionCall" in part) || !part.functionCall) {
      continue;
    }
    if (typeof part.thoughtSignature !== "string" || part.thoughtSignature.length === 0) {
      return false;
    }
  }
  return true;
}

function normalizeFunctionCallPart(part: GoogleFunctionCallPart): LlmToolCall {
  const args = part.functionCall.args ?? {};
  const thoughtSignature = typeof part.thoughtSignature === "string"
    ? part.thoughtSignature
    : "";
  return {
    id: part.functionCall.id ?? `google_tool_call_${hashFunctionCall(part.functionCall.name ?? "", args)}`,
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

function sanitizeGeminiSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGeminiSchemaNode(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, rawChild] of Object.entries(value)) {
    if (key === "additionalProperties") {
      continue;
    }
    result[key] = sanitizeGeminiSchemaNode(rawChild);
  }
  return result;
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

function parseChunk(payload: string): GoogleStreamChunk | null {
  try {
    return JSON.parse(payload) as GoogleStreamChunk;
  } catch {
    return null;
  }
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

function dataUrlToBase64(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) {
    return null;
  }

  return {
    mimeType: String(match[1] ?? "application/octet-stream"),
    data: String(match[2] ?? "")
  };
}

function inferAudioMimeType(format: string): string {
  const normalized = String(format).trim().toLowerCase();
  switch (normalized) {
    case "mp3":
    case "mpeg":
    case "mpga":
      return "audio/mpeg";
    case "m4a":
    case "mp4":
      return "audio/mp4";
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
    default:
      return "audio/mpeg";
  }
}

function hashFunctionCall(name: string, args: Record<string, unknown>): string {
  return Buffer.from(`${name}:${JSON.stringify(args)}`).toString("base64url").slice(0, 16);
}

class ProviderCompatibilityGuards {
  constructor(private readonly context: LlmProviderRequestContext | null) {}

  static passThrough(): ProviderCompatibilityGuards {
    return new ProviderCompatibilityGuards(null);
  }

  createInlineDataError(): Error {
    return new Error(`${this.context ? resolveProviderLabel(this.context) : "Gemini provider"} only supports inline image data URLs`);
  }

  supportsFunctionPartIds(): boolean {
    if (!this.context) {
      return true;
    }

    return this.context.providerConfig.type !== "vertex_express";
  }
}

function resolveProviderLabel(context: LlmProviderRequestContext): string {
  return context.providerConfig.type === "vertex"
    ? "Vertex AI"
    : "Google AI Studio";
}

export function buildGoogleAiStudioStreamEndpoint(rawBaseUrl: string, model: string): string {
  const { baseUrl, apiVersion } = parseGoogleAiStudioEndpoint(rawBaseUrl);
  const versionSegment = apiVersion ? `/${apiVersion}` : "";
  return `${baseUrl}${versionSegment}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

function parseGoogleAiStudioEndpoint(rawBaseUrl: string): { baseUrl: string; apiVersion: string | undefined } {
  const sanitized = rawBaseUrl
    .replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent).*$/i, "")
    .replace(/\/$/, "");
  const url = new URL(sanitized);
  const segments = url.pathname.split("/").filter(Boolean);
  const versionIndex = segments.findIndex((segment) => /^v\d+(?:alpha|beta)?$/i.test(segment));

  if (versionIndex === -1) {
    return {
      baseUrl: `${url.origin}${segments.length > 0 ? `/${segments.join("/")}` : ""}`,
      apiVersion: undefined
    };
  }

  const baseSegments = segments.slice(0, versionIndex);
  return {
    baseUrl: `${url.origin}${baseSegments.length > 0 ? `/${baseSegments.join("/")}` : ""}`,
    apiVersion: segments[versionIndex]
  };
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
