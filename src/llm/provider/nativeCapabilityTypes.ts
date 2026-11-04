import type { LlmUsage } from "./providerTypes.ts";

export interface NativeCapabilityParams {
  modelRefOverride?: string | string[];
  timeoutMsOverride?: number;
  abortSignal?: AbortSignal;
  skipDebugDump?: boolean;
}

export interface LlmTranscribeParams extends NativeCapabilityParams {
  audio: { data: string; format: string; mimeType?: string };
  language?: string;
  prompt?: string;
}
export interface LlmTranscribeResult { text: string; usage: LlmUsage }

export type SpeechFormat = "mp3" | "opus" | "aac" | "flac" | "wav";
export interface LlmSynthesizeParams extends NativeCapabilityParams {
  text: string;
  voice?: string;
  instructions?: string;
  format?: SpeechFormat;
  speed?: number;
}
export interface LlmSynthesizeResult {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  usage: LlmUsage;
}

export type DecisionContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" | "original" }
  | { type: "input_json"; data: Record<string, unknown> | Record<string, unknown>[] };
export type DecisionInstructions = string | DecisionContentPart[];
export type DecisionQuestion = { name: string; instructions: DecisionInstructions } & (
  | { type: "predicate" }
  | { type: "choice"; choices: Array<{ value: string | boolean; description?: string }> }
  | { type: "score"; levels: Array<{ label: string; description?: string }> }
);
export type DecisionInput = string | Array<{
  role: "user"; content: string | DecisionContentPart[];
} | {
  role: "system" | "developer"; content: string | Array<{ type: "input_text"; text: string }>;
} | {
  role: "assistant"; content: string | Array<{ type: "output_text"; text: string } | { type: "refusal"; refusal: string }>;
}>;
export type DecisionAnswer = { name: string } & (
  | { type: "predicate"; probability: number }
  | { type: "choice"; choice: string | boolean; confidence: number; probabilities: Array<{ value: string | boolean; probability: number }> }
  | { type: "score"; score: number; confidence: number; probabilities: Array<{ value: number; label: string; probability: number }> }
  | { type: "refusal" }
);
export interface LlmDecideParams extends NativeCapabilityParams { input: DecisionInput; questions: DecisionQuestion[] }
export interface LlmDecideResult { answers: DecisionAnswer[]; usage: LlmUsage }
