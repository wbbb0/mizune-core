import type { LlmTranscribeParams, LlmTranscribeResult, LlmSynthesizeParams, LlmSynthesizeResult, LlmDecideParams, LlmDecideResult } from "./nativeCapabilityTypes.ts";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmProviderConfig, ModelProfile } from "#config/configModel.ts";
import type { ToolExecutionEffect } from "../toolExecutionScheduler.ts";

export interface LlmContentPartText {
  type: "text";
  text: string;
}

export interface LlmContentPartImageUrl {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export interface LlmContentPartVideoUrl {
  type: "video_url";
  video_url: { url: string };
  durationMs?: number;
  fps?: number;
}

export interface LlmContentPartInputAudio {
  type: "input_audio";
  input_audio: {
    data: string;
    format: string;
    mimeType?: string;
  };
}

export type LlmContentPart = LlmContentPartText | LlmContentPartImageUrl | LlmContentPartVideoUrl | LlmContentPartInputAudio;

export interface LlmToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  providerMetadata?: {
    google?: {
      thoughtSignature?: string;
    };
  };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  contextHistoryTimestampMs?: number;
  contextHistorySummary?: boolean;
  content: string | LlmContentPart[];
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
  reasoning_content?: string;
  providerMetadata?: Record<string, unknown>;
}

export type LlmResponseFormat =
  | { type: "json_schema"; name: string; schema: Record<string, unknown>; strict?: boolean }
  | { type: "json_object" };

export interface LlmGenerateParams {
  responseFormat?: LlmResponseFormat;
  operation?: "chat" | "transcription";
  messages: LlmMessage[];
  abortSignal?: AbortSignal;
  tools?: LlmToolDefinition[] | (() => LlmToolDefinition[]);
  consumeSteerMessages?: () => Promise<LlmMessage[]> | LlmMessage[];
  consumeInlineTriggers?: () => Promise<LlmMessage[]> | LlmMessage[];
  projectMessagesBeforeProvider?: (messages: LlmMessage[]) => Promise<LlmMessage[]> | LlmMessage[];
  prepareRequestForBudget?: (input: {
    messages: LlmMessage[];
    tools: LlmToolDefinition[];
    modelRef: string;
    budget: import("../shared/requestTokenBudget.ts").RequestTokenBudget;
  }) => Promise<LlmMessage[]>;
  // Provisional text is display-only and must be cleared on reset; never deliver it as a committed message.
  onPreviewTextDelta?: (delta: string) => Promise<void> | void;
  onPreviewReset?: () => Promise<void> | void;
  onTextDelta?: (delta: string) => Promise<void> | void;
  // Opt-in irreversible delivery of provider body text. Once invoked, this candidate cannot be replayed through fallback.
  // Reasoning and structured-output responses never enter this channel.
  onIrreversibleTextDelta?: (delta: string) => Promise<void> | void;
  onReasoningDelta?: (delta: string) => void;
  toolExecutor?: (toolCall: LlmToolCall) => Promise<string | LlmToolExecutionResult>;
  onAssistantToolCalls?: (message: LlmMessage, usage?: LlmProviderCallUsage) => Promise<void> | void;
  onProviderResponseComplete?: (event: LlmProviderResponseCompleteEvent) => Promise<void> | void;
  resolveAssistantToolCallContent?: (event: LlmProviderResponseCompleteEvent) => string;
  onToolResultMessage?: (
    message: LlmMessage,
    toolCall: LlmToolCall | string,
    result?: LlmToolResultMessageMetadata
  ) => Promise<void> | void;
  toolConcurrency?: {
    analyze: (toolCall: LlmToolCall, index: number) => ToolExecutionEffect;
    maxConcurrency?: number;
  };
  onProviderCallUsage?: (usage: LlmProviderCallUsage) => Promise<void> | void;
  onFallbackEvent?: (event: LlmFallbackEvent) => Promise<void> | void;
  modelOverride?: string;
  modelRefOverride?: string | string[];
  resolveModelRefOverride?: () => string | string[];
  timeoutMsOverride?: number;
  maxOutputTokensOverride?: number;
  enableThinkingOverride?: boolean;
  preferNativeNoThinkingChatEndpoint?: boolean;
  skipDebugDump?: boolean;
}

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  requestCount: number;
  providerReported: boolean;
  modelRef: string | null;
  model: string | null;
}

export type LlmCompletionStatus = "completed" | "truncated" | "unknown";

export interface LlmGenerateResult {
  text: string;
  reasoningContent: string;
  usage: LlmUsage;
  finishReason: LlmGenerateFinishReason;
  completionStatus?: LlmCompletionStatus;
  providerCallUsages?: LlmProviderCallUsage[];
  assistantMetadata?: Record<string, unknown>;
}

export type LlmToolLoopLimitCause = "tool_iterations" | "protocol_recovery";

export type LlmGenerateFinishReason =
  | { kind: "completed" }
  | {
      kind: "tool_call_limit";
      maxIterations: number;
      cause?: LlmToolLoopLimitCause;
      protocolRecoveries?: number;
    };

export interface LlmEmbeddingParams {
  purpose?: "query" | "document";
  texts: string[];
  abortSignal?: AbortSignal;
  timeoutMsOverride?: number;
}

export interface LlmEmbeddingResult {
  vectors: number[][];
  usage: LlmUsage;
}

export interface LlmProviderCallUsage {
  iteration: number;
  phase: "tool_call" | "final_response" | "terminal_response" | "invalid_response";
  usage: LlmUsage;
  text: string;
  reasoningContent: string;
}

export interface LlmProviderResponseCompleteEvent {
  iteration: number;
  phase: "tool_call" | "final_response" | "invalid_response";
  text: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  reasoningContent: string;
}

export interface LlmToolExecutionResult {
  content: string;
  canonicalContent?: string;
  supplementalMessages?: LlmMessage[];
  terminalResponse?: {
    text: string;
  };
  toString?: () => string;
}

export interface LlmToolResultMessageMetadata {
  canonicalContent?: string;
}

export interface LlmFallbackEvent {
  summary: string;
  details: string;
  fromModelRef: string;
  toModelRef: string;
  fromProvider: string;
  toProvider: string;
}

export interface LlmProviderRequestContext {
  operation?: "chat" | "transcription";
  config: AppConfig;
  logger: Logger;
  modelRef: string;
  candidateIndex: number;
  model: string;
  baseUrl: string;
  modelProfile: ModelProfile;
  providerName: string;
  providerConfig: LlmProviderConfig;
}

export interface LlmProviderGenerateParams {
  responseFormat?: LlmResponseFormat;
  messages: LlmMessage[];
  abortSignal?: AbortSignal;
  tools?: LlmToolDefinition[];
  onTextDelta?: (delta: string) => Promise<void> | void;
  onReasoningDelta?: (delta: string) => void;
  timeoutMsOverride?: number;
  maxOutputTokensOverride?: number;
  enableThinkingOverride?: boolean;
  preferNativeNoThinkingChatEndpoint?: boolean;
  skipDebugDump?: boolean;
}

export interface LlmProviderGenerateResult {
  text: string;
  reasoningContent: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  completionStatus?: LlmCompletionStatus;
  assistantMetadata?: Record<string, unknown>;
}

export interface LlmProvider {
  readonly type: LlmProviderConfig["type"];
  readonly supportsStructuredOutput?: boolean;
  transcribe?(context: LlmProviderRequestContext, params: LlmTranscribeParams): Promise<LlmTranscribeResult>;
  synthesize?(context: LlmProviderRequestContext, params: LlmSynthesizeParams): Promise<LlmSynthesizeResult>;
  decide?(context: LlmProviderRequestContext, params: LlmDecideParams): Promise<LlmDecideResult>;
  resolveBaseUrl(providerConfig: LlmProviderConfig): string | null;
  generate(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult>;
  embed?(
    context: LlmProviderRequestContext,
    params: LlmEmbeddingParams
  ): Promise<LlmEmbeddingResult>;
}

export function createEmptyUsage(modelRef: string | null, model: string | null): LlmUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    requestCount: 0,
    providerReported: false,
    modelRef,
    model
  };
}

export function mergeUsage(target: LlmUsage, incoming: LlmUsage): LlmUsage {
  target.inputTokens = sumNullable(target.inputTokens, incoming.inputTokens);
  target.outputTokens = sumNullable(target.outputTokens, incoming.outputTokens);
  target.totalTokens = sumNullable(target.totalTokens, incoming.totalTokens);
  target.cachedTokens = sumNullable(target.cachedTokens, incoming.cachedTokens);
  target.reasoningTokens = sumNullable(target.reasoningTokens, incoming.reasoningTokens);
  target.requestCount += incoming.requestCount;
  target.providerReported = target.providerReported || incoming.providerReported;
  target.modelRef = incoming.modelRef ?? target.modelRef;
  target.model = incoming.model ?? target.model;
  return target;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumNullable(left: number | null, right: number | null): number | null {
  if (left == null && right == null) {
    return null;
  }
  return (left ?? 0) + (right ?? 0);
}
