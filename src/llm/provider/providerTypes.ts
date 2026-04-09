import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { LlmProviderConfig, ModelProfile } from "#config/configModel.ts";

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

export interface LlmContentPartInputAudio {
  type: "input_audio";
  input_audio: {
    data: string;
    format: string;
    mimeType?: string;
  };
}

export type LlmContentPart = LlmContentPartText | LlmContentPartImageUrl | LlmContentPartInputAudio;

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
  content: string | LlmContentPart[];
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
  reasoning_content?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface LlmGenerateParams {
  messages: LlmMessage[];
  abortSignal?: AbortSignal;
  tools?: LlmToolDefinition[] | (() => LlmToolDefinition[]);
  consumeSteerMessages?: () => Promise<LlmMessage[]> | LlmMessage[];
  onTextDelta?: (delta: string) => Promise<void> | void;
  toolExecutor?: (toolCall: LlmToolCall) => Promise<string | LlmToolExecutionResult>;
  onAssistantToolCalls?: (message: LlmMessage) => Promise<void> | void;
  onToolResultMessage?: (message: LlmMessage, toolName: string) => Promise<void> | void;
  onFallbackEvent?: (event: LlmFallbackEvent) => Promise<void> | void;
  modelOverride?: string;
  modelRefOverride?: string | string[];
  timeoutMsOverride?: number;
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

export interface LlmGenerateResult {
  text: string;
  usage: LlmUsage;
}

export interface LlmToolExecutionResult {
  content: string;
  supplementalMessages?: LlmMessage[];
  terminalResponse?: {
    text: string;
  };
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
  messages: LlmMessage[];
  abortSignal?: AbortSignal;
  tools?: LlmToolDefinition[];
  onTextDelta?: (delta: string) => Promise<void> | void;
  timeoutMsOverride?: number;
  enableThinkingOverride?: boolean;
  preferNativeNoThinkingChatEndpoint?: boolean;
  skipDebugDump?: boolean;
}

export interface LlmProviderGenerateResult {
  text: string;
  reasoningContent: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  assistantMetadata?: Record<string, unknown>;
}

export interface LlmProvider {
  readonly type: LlmProviderConfig["type"];
  resolveBaseUrl(providerConfig: LlmProviderConfig): string | null;
  generate(
    context: LlmProviderRequestContext,
    params: LlmProviderGenerateParams
  ): Promise<LlmProviderGenerateResult>;
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
