import type { ModelProfile, LlmProviderConfig } from "#config/configModel.ts";

/** This is the same preprocessing identity for queries and documents in one embedding space. */
export function embeddingInputProfile(settings: NonNullable<ModelProfile["embedding"]>, provider: LlmProviderConfig) {
  return {
    inputMode: settings.inputMode,
    ...(settings.inputMode === "qwen3" ? { queryInstruction: settings.queryInstruction } : {}),
    ...(settings.inputMode === "task_prefix" ? { queryPrefix: settings.queryPrefix, documentPrefix: settings.documentPrefix } : {}),
    ...(provider.type === "google" ? { vectorNormalization: "l2-v1" } : {})
  };
}
