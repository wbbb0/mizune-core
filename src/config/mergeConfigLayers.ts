import { DEFAULT_CONTENT_SAFETY_PROVIDER } from "./contentSafetyConfig.ts";
import { deepMergeAllReplaceArrays, isPlainObject } from "#data/schema/helpers.ts";

/** 配置层合并时，模型身份和审核供应商参数必须保持各自完整的归属边界。 */
export function mergeConfigLayers(layers: readonly Record<string, unknown>[]): Record<string, unknown> {
  const merged = deepMergeAllReplaceArrays(layers);
  for (const layer of layers) {
    const context = layer.context;
    const embedding = isPlainObject(context) ? context.embedding : undefined;
    if (!isPlainObject(embedding) || !Object.hasOwn(embedding, "model")) continue;
    const mergedContext = merged.context as Record<string, unknown>;
    const mergedEmbedding = mergedContext.embedding as Record<string, unknown>;
    mergedEmbedding.model = structuredClone(embedding.model);
  }
  // 切换审核供应商时重新开始合并其专属参数，防止继承上一家供应商的凭据和服务名。
  let safetyProvider: unknown = DEFAULT_CONTENT_SAFETY_PROVIDER;
  let safetySettings: unknown = {};
  let hasSafetySettings = false;
  for (const layer of layers) {
    const safety = layer.contentSafety;
    if (!isPlainObject(safety)) continue;
    if (Object.hasOwn(safety, "provider") && safety.provider !== safetyProvider) {
      safetyProvider = safety.provider;
      safetySettings = {};
      hasSafetySettings = true;
    }
    if (Object.hasOwn(safety, "config")) {
      safetySettings = isPlainObject(safety.config)
        ? deepMergeAllReplaceArrays([isPlainObject(safetySettings) ? safetySettings : {}, safety.config])
        : structuredClone(safety.config);
      hasSafetySettings = true;
    }
  }
  if (hasSafetySettings && isPlainObject(merged.contentSafety)) merged.contentSafety.config = safetySettings;
  return merged;
}
