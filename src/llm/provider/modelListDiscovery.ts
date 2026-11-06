import { getLlmProviderByType } from "./providerRegistry.ts";
import type { LlmProviderType } from "#config/llmProviderDefinitions.ts";
import type { ModelDiscoveryInput } from "./modelDiscoveryTypes.ts";
import { fillMissingModelFields, type DiscoveredModel } from "./modelDiscoveryMetadata.ts";
export { resolveProviderModelListEndpoint } from "./nativeModelDiscovery.ts";

export interface ProviderModelSlot {
  upstreamModel: string;
  alias: string;
  exists: boolean;
  profile: Record<string, unknown>;
  suggested: Record<string, unknown>;
  sources: string[];
}
export type ProviderModelListResult =
  | { kind: "ok"; providerType: LlmProviderType; endpoint: string; models: ProviderModelSlot[]; warnings: string[] }
  | { kind: "unsupported"; providerType: LlmProviderType; reason: string };

export function slugifyModelAlias(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "model";
}
export function stageProviderModels(models: readonly DiscoveredModel[], existingModels: Readonly<Record<string, Record<string, unknown>>>): ProviderModelSlot[] {
  const used = new Set(Object.keys(existingModels));
  const existingByUpstream = new Map<string, [string, Record<string, unknown>]>();
  for (const [alias, model] of Object.entries(existingModels)) {
    if (typeof model.upstreamModel === "string" && !existingByUpstream.has(model.upstreamModel)) {
      existingByUpstream.set(model.upstreamModel, [alias, model]);
    }
  }
  const merged = new Map<string, { profile: Record<string, unknown>; sources: string[] }>();
  for (const item of models) {
    const previous = merged.get(item.id);
    merged.set(item.id, { profile: fillMissingModelFields(previous?.profile ?? {}, item.profile), sources: [...new Set([...(previous?.sources ?? []), item.source])] });
  }
  return [...merged].map(([upstreamModel, discovered]) => {
    const existing = existingByUpstream.get(upstreamModel);
    const base = slugifyModelAlias(upstreamModel);
    let alias = existing?.[0] ?? base;
    if (!existing) { for (let i = 2; used.has(alias); i++) alias = `${base}_${i}`; }
    used.add(alias);
    const { upstreamModel: _id, ...existingProfile } = existing?.[1] ?? {};
    return { upstreamModel, alias, exists: !!existing, profile: fillMissingModelFields(existingProfile, discovered.profile), suggested: discovered.profile, sources: discovered.sources };
  });
}

export async function listProviderModelSlots(input: ModelDiscoveryInput & { existingModels?: Record<string, Record<string, unknown>> }): Promise<ProviderModelListResult> {
  const result = await getLlmProviderByType(input.provider.type).discoverModels(input);
  if (result.kind === "unsupported") return result;
  return { ...result, models: stageProviderModels(result.models, input.existingModels ?? input.provider.models) };
}
