import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { ModelProfile, LlmProviderConfig } from "#config/configModel.ts";
import type { ImageEditSource } from "./imageEditInputs.ts";

export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  modelRef: string;
  revisedPrompt?: string;
}
export interface GenerateImageInput {
  prompt: string;
  logger?: Logger;
  skipDebugDump?: boolean;
  size?: string;
  quality?: string;
  aspectRatio?: string;
  resolution?: string;
  outputFormat?: string;
  frameCount?: number;
  frameDurationMs?: number;
  referenceImages?: ImageEditSource[];
  mask?: ImageEditSource;
  abortSignal?: AbortSignal;
}
export interface ImageProtocolRequest {
  config: AppConfig;
  target: { modelRef: string; profile: ModelProfile; provider: LlmProviderConfig };
  input: GenerateImageInput;
  prompt: string;
  settings: Record<string, unknown>;
  signal: AbortSignal;
}
export interface GeneratedImageBytes { buffer: Buffer; revisedPrompt?: string }
