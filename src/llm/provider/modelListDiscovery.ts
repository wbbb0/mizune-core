import { createAiStudioClient, normalizeGoogleSdkError, resolveAiStudioEndpoint } from "./providers/googleSdkClient.ts";
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
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1", openai_compatible: "https://api.openai.com/v1", openai_responses_compatible: "https://api.openai.com/v1",
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
  if (provider.type === "google") { const sdk = resolveAiStudioEndpoint(base); return { endpoint: `${sdk.baseUrl}/${sdk.apiVersion}/models` }; }
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

export async function listProviderModelSlots(input: { provider: LlmCatalogProviderFile; config: AppConfig; fetchTimeoutMs?: number; abortSignal?: AbortSignal; existingModels?: Record<string, Record<string, unknown>> }): Promise<ProviderModelListResult> {
  input.abortSignal?.throwIfAborted();
  const operationSignal = AbortSignal.any([AbortSignal.timeout(input.fetchTimeoutMs ?? 15000), ...(input.abortSignal ? [input.abortSignal] : [])]);
  const resolved = resolveProviderModelListEndpoint(input.provider);
  if ("unsupported" in resolved) return { kind: "unsupported", providerType: input.provider.type, reason: resolved.reason };
  const type = input.provider.type;
  if (type === "google") {
    const client = createAiStudioClient({ config: input.config, apiKey: input.provider.apiKey, baseUrl: input.provider.baseUrl, providerProxy: input.provider.proxy });
    const signal = operationSignal;
    try {
      const models: DiscoveredModel[] = [];
      const pager = await client.models.list({ config: { pageSize: 1000, abortSignal: signal } });
      for (let page = 1; ; page++) {
        signal.throwIfAborted();
        models.push(...parseDiscoveredModels({ models: pager.page.map(model => ({ ...model, supportedGenerationMethods: model.supportedActions })) }, resolved.endpoint, "google"));
        if (!pager.hasNextPage()) break;
        if (page >= 50) throw new Error("模型清单分页超过 50 页");
        await pager.nextPage();
      }
      return { kind: "ok", providerType: type, endpoint: resolved.endpoint, models: stageProviderModels(models, input.existingModels ?? input.provider.models), warnings: [] };
    } catch (error) { operationSignal.throwIfAborted(); throw normalizeGoogleSdkError(error); }
  }
  type Kind = Parameters<typeof parseDiscoveredModels>[2];
  const sources: Array<{ endpoint: string; kind: Kind }> = [{ endpoint: resolved.endpoint, kind: type === "openrouter" ? "chat" : ["google", "lmstudio", "anthropic"].includes(type) ? type as Kind : "generic" }];
  if (type === "openrouter") {
    const base = resolved.endpoint.replace(/\/models$/, "");
    sources.push({ endpoint: `${base}/embeddings/models`, kind: "embedding" }, { endpoint: `${base}/images/models`, kind: "image" });
  }
  const headers: Record<string, string> = type === "anthropic"
    ? { "x-api-key": input.provider.apiKey ?? "", "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${input.provider.apiKey ?? ""}` };
  const results = await Promise.allSettled(sources.map(async (source) => {
    const models: DiscoveredModel[] = [];
    let next: string | null = source.endpoint;
    const visited = new Set<string>();
    const signal = operationSignal;
    while (next) {
      if (visited.has(next) || visited.size >= 50) throw new Error("模型清单分页异常");
      visited.add(next);
      const response = await fetchWithProxy(input.config, "llm", next, { method: "GET", headers, signal }, { providerProxy: input.provider.proxy });
      if (!response.ok) throw new Error(`模型清单接口返回 ${response.status} ${response.statusText}：${(await response.text()).slice(0, 400)}`);
      const payload = await response.json() as Record<string, any>;
      models.push(...parseDiscoveredModels(payload, source.endpoint, source.kind));
      next = null;
      if (type === "anthropic" && payload.has_more && payload.last_id) {
        const url = new URL(source.endpoint); url.searchParams.set("after_id", payload.last_id); next = url.href;
      }
    }
    return models;
  }));
  operationSignal.throwIfAborted();
  const models: DiscoveredModel[] = [], warnings: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") models.push(...result.value);
    else warnings.push(`${sources[i]!.endpoint}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  if (results.every((result) => result.status === "rejected")) throw new Error(warnings.join("\n"));
  return { kind: "ok", providerType: type, endpoint: sources.map((source) => source.endpoint).join(" · "), models: stageProviderModels(models, input.existingModels ?? input.provider.models), warnings };
}
