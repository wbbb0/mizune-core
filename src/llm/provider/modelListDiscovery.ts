import type { AppConfig } from "#config/config.ts";
import type { LlmCatalogProviderFile } from "#config/configModel.ts";
import type { LlmProviderType } from "#config/llmProviderDefinitions.ts";
import { fetchWithProxy } from "#services/proxy/index.ts";
import { fillMissingModelFields, parseDiscoveredModels, type DiscoveredModel } from "./modelDiscoveryMetadata.ts";

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

const DEFAULTS: Partial<Record<LlmProviderType, string>> = {
  openrouter: "https://openrouter.ai/api/v1", openai: "https://api.openai.com/v1", openai_responses: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com", dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  lmstudio: "http://localhost:1234/v1", anthropic: "https://api.anthropic.com", google: "https://generativelanguage.googleapis.com/v1beta"
};

export function slugifyModelAlias(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "model";
}
export function resolveProviderModelListEndpoint(provider: { type: LlmProviderType; baseUrl?: string }): { endpoint: string } | { unsupported: true; reason: string } {
  if (!(provider.type in DEFAULTS)) return { unsupported: true, reason: `供应商类型 ${provider.type} 暂不支持自动拉取模型清单` };
  const base = provider.baseUrl ?? DEFAULTS[provider.type];
  if (!base) return { unsupported: true, reason: `供应商类型 ${provider.type} 暂不支持自动拉取模型清单` };
  let normalized = base.replace(/\/+$/, "");
  if (provider.type === "deepseek") normalized = normalized.replace(/\/anthropic$/, "");
  if (provider.type === "dashscope") normalized = normalized.replace(/\/api\/v1$/, "/compatible-mode/v1");
  if (provider.type === "lmstudio") return { endpoint: `${normalized.replace(/\/v1$/, "")}/api/v1/models` };
  return { endpoint: `${normalized}${provider.type === "anthropic" ? "/v1/models?limit=1000" : "/models"}` };
}

export function stageProviderModels(models: readonly DiscoveredModel[], existingModels: Readonly<Record<string, Record<string, unknown>>>): ProviderModelSlot[] {
  const used = new Set(Object.keys(existingModels));
  const merged = new Map<string, { profile: Record<string, unknown>; sources: string[] }>();
  for (const item of models) {
    const previous = merged.get(item.id);
    merged.set(item.id, { profile: fillMissingModelFields(previous?.profile ?? {}, item.profile), sources: [...new Set([...(previous?.sources ?? []), item.source])] });
  }
  return [...merged].map(([upstreamModel, discovered]) => {
    const existing = Object.entries(existingModels).find(([, model]) => model.upstreamModel === upstreamModel);
    const base = slugifyModelAlias(upstreamModel);
    let alias = existing?.[0] ?? base;
    if (!existing) { for (let i = 2; used.has(alias); i++) alias = `${base}_${i}`; }
    used.add(alias);
    const { upstreamModel: _id, ...existingProfile } = existing?.[1] ?? {};
    return { upstreamModel, alias, exists: !!existing, profile: fillMissingModelFields(existingProfile, discovered.profile), suggested: discovered.profile, sources: discovered.sources };
  });
}

export async function listProviderModelSlots(input: { provider: LlmCatalogProviderFile; config: AppConfig; fetchTimeoutMs?: number; existingModels?: Record<string, Record<string, unknown>> }): Promise<ProviderModelListResult> {
  const resolved = resolveProviderModelListEndpoint(input.provider);
  if ("unsupported" in resolved) return { kind: "unsupported", providerType: input.provider.type, reason: resolved.reason };
  const type = input.provider.type;
  type Kind = Parameters<typeof parseDiscoveredModels>[2];
  const sources: Array<{ endpoint: string; kind: Kind }> = [{ endpoint: resolved.endpoint, kind: type === "openrouter" ? "chat" : ["google", "lmstudio", "anthropic"].includes(type) ? type as Kind : "generic" }];
  if (type === "openrouter") {
    const base = resolved.endpoint.replace(/\/models$/, "");
    sources.push({ endpoint: `${base}/embeddings/models`, kind: "embedding" }, { endpoint: `${base}/images/models`, kind: "image" });
  }
  const headers: Record<string, string> = type === "anthropic"
    ? { "x-api-key": input.provider.apiKey ?? "", "anthropic-version": "2023-06-01" }
    : type === "google" ? { "x-goog-api-key": input.provider.apiKey ?? "" }
      : { Authorization: `Bearer ${input.provider.apiKey ?? ""}` };
  const results = await Promise.allSettled(sources.map(async (source) => {
    const models: DiscoveredModel[] = [];
    let next: string | null = source.endpoint;
    const visited = new Set<string>();
    const signal = AbortSignal.timeout(input.fetchTimeoutMs ?? 15000);
    while (next) {
      if (visited.has(next) || visited.size >= 50) throw new Error("模型清单分页异常");
      visited.add(next);
      const response = await fetchWithProxy(input.config, "llm", next, { method: "GET", headers, signal }, { providerProxy: input.provider.proxy });
      if (!response.ok) throw new Error(`模型清单接口返回 ${response.status} ${response.statusText}：${(await response.text()).slice(0, 400)}`);
      const payload = await response.json() as Record<string, any>;
      models.push(...parseDiscoveredModels(payload, source.endpoint, source.kind));
      next = null;
      if (type === "google" && payload.nextPageToken) {
        const url = new URL(source.endpoint); url.searchParams.set("pageToken", payload.nextPageToken); next = url.href;
      } else if (type === "anthropic" && payload.has_more && payload.last_id) {
        const url = new URL(source.endpoint); url.searchParams.set("after_id", payload.last_id); next = url.href;
      }
    }
    return models;
  }));
  const models: DiscoveredModel[] = [], warnings: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") models.push(...result.value);
    else warnings.push(`${sources[i]!.endpoint}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  if (results.every((result) => result.status === "rejected")) throw new Error(warnings.join("\n"));
  return { kind: "ok", providerType: type, endpoint: sources.map((source) => source.endpoint).join(" · "), models: stageProviderModels(models, input.existingModels ?? input.provider.models), warnings };
}
