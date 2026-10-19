import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigRuntime } from "./configModel.ts";
import type { LlmCatalogProviderMutation } from "./llmCatalogMutations.ts";
import { readConfigFileRaw } from "#data/schema/file.ts";

/** Shared catalog changes must cover every instance, including ones not currently running. */
export async function readEmbeddingConfigLayers(runtime: ConfigRuntime): Promise<Array<{ path: string; value: Record<string, any> }>> {
  const directory = join(runtime.configDir, "instances");
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const paths = [...new Set([runtime.globalConfigPath, runtime.instanceConfigPath, ...entries.filter(entry => entry.isFile() && /\.ya?ml$/.test(entry.name)).map(entry => join(directory, entry.name))])].sort();
  return Promise.all(paths.map(async path => ({ path, value: await readConfigFileRaw(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return {};
    throw error;
  }) })));
}

export function mutateEmbeddingConfigReference(value: Record<string, any>, mutations: readonly LlmCatalogProviderMutation[]): Record<string, any> {
  const next = structuredClone(value);
  for (const mutation of mutations) {
    const target = next.context?.embedding?.model;
    if (target?.provider !== mutation.provider) continue;
    if (mutation.kind === "rename_provider") target.provider = mutation.nextProvider;
    else next.context.embedding.model = null;
  }
  return next;
}
