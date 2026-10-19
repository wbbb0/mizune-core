import { deepMergeAllReplaceArrays, isPlainObject } from "#data/schema/helpers.ts";

/** Model identities are atomic: an instance cannot inherit half a provider/model pair. */
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
  return merged;
}
