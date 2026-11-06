import type { AppConfig } from "#config/config.ts";
import type { LlmCatalogProviderFile } from "#config/configModel.ts";
import type { LlmProviderType } from "#config/llmProviderDefinitions.ts";
import type { DiscoveredModel } from "./modelDiscoveryMetadata.ts";

export interface ModelDiscoveryInput {
  provider: LlmCatalogProviderFile;
  config: AppConfig;
  fetchTimeoutMs?: number;
  abortSignal?: AbortSignal;
}

export type NativeModelDiscoveryResult =
  | { kind: "ok"; providerType: LlmProviderType; endpoint: string; models: DiscoveredModel[]; warnings: string[] }
  | { kind: "unsupported"; providerType: LlmProviderType; reason: string };
