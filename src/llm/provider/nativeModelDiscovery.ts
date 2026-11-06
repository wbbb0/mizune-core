import { createAiStudioClient, normalizeGoogleSdkError, resolveAiStudioEndpoint } from "./providers/googleSdkClient.ts";
import type { LlmProviderType } from "#config/llmProviderDefinitions.ts";
import { fetchWithProxy } from "#services/proxy/index.ts";
import { parseDiscoveredModels, type DiscoveredModel } from "./modelDiscoveryMetadata.ts";
import type { ModelDiscoveryInput, NativeModelDiscoveryResult } from "./modelDiscoveryTypes.ts";

export type ModelDiscoverySource = { endpoint: string; kind: Parameters<typeof parseDiscoveredModels>[2] };

const DEFAULTS: Partial<Record<LlmProviderType, string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1", openai_compatible: "https://api.openai.com/v1", openai_responses_compatible: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com", dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  lmstudio: "http://localhost:1234/v1", anthropic: "https://api.anthropic.com", google: "https://generativelanguage.googleapis.com/v1beta"
};

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

export async function fetchNativeProviderModels(input: ModelDiscoveryInput, sourceOverrides?: ModelDiscoverySource[]): Promise<NativeModelDiscoveryResult> {
  // 基类统一管理整体预算，原生适配器只消费其信号。
  const operationSignal = input.abortSignal;
  if (!operationSignal) throw new Error("模型发现必须传入统一取消信号");
  operationSignal.throwIfAborted();
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
      return { kind: "ok", providerType: type, endpoint: resolved.endpoint, models, warnings: [] };
    } catch (error) { operationSignal.throwIfAborted(); throw normalizeGoogleSdkError(error); }
  }
  const sources = sourceOverrides ?? [{ endpoint: resolved.endpoint, kind: ["lmstudio", "anthropic"].includes(type) ? type as "lmstudio" | "anthropic" : "generic" }];
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
  return { kind: "ok", providerType: type, endpoint: sources.map((source) => source.endpoint).join(" · "), models, warnings };
}
