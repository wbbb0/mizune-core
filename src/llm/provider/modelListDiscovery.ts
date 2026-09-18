import type { AppConfig } from "#config/config.ts";
import type { LlmCatalogProviderFile } from "#config/configModel.ts";
import type { LlmProviderType } from "#config/llmProviderDefinitions.ts";
import { llmProviderDefinitions } from "#config/llmProviderDefinitions.ts";
import { fetchWithProxy } from "#services/proxy/index.ts";

/**
 * 模型清单发现：从供应商的模型清单接口拉取可用模型，并把上游模型名生成为
 * `[a-z0-9_]` 格式的局部模型别名，供 LLM 目录编辑器一键导入。
 *
 * 拉取只依赖 provider 的连接信息（type / baseUrl / apiKey / proxy），不触碰持久化文件；
 * 已有的模型目录由调用方通过 `existingAliases` 传入，用于识别“已导入”与别名去重。
 */

/** 单条可导入的模型槽位：上游模型名 + 自动生成的别名 + 按供应商类型裁剪的能力草案。 */
export interface ProviderModelSlot {
  /** 上游模型名（作为模型目录里的 upstreamModel）。 */
  upstreamModel: string;
  /** `[a-z0-9_]` 格式的局部模型别名，可在前端编辑。 */
  alias: string;
  /** 模型目录中已存在同名上游模型，导入时将更新该条目而不是新增。 */
  exists: boolean;
  /** 该供应商类型可配置的模型能力草案（只含 Schema 中适用的字段）。 */
  capabilities: Record<string, string | boolean>;
}

export type ProviderModelListResult =
  | { kind: "ok"; providerType: LlmProviderType; endpoint: string | null; models: ProviderModelSlot[] }
  | { kind: "unsupported"; providerType: LlmProviderType; reason: string };

const MODEL_LIST_TIMEOUT_MS = 15000;

/**
 * 模型清单接口的默认地址。注意它与生成链路的 `resolveBaseUrl` 并不总一致：
 * deepseek 的生成默认走 Anthropic 兼容端点（`api.deepseek.com/anthropic`），
 * 但模型清单按 OpenAI 兼容协议从根路径提供，这里单独维护一份映射并做协议归一化。
 */
const DEFAULT_MODEL_LIST_BASE_URLS: Partial<Record<LlmProviderType, string>> = {
  openai: "https://api.openai.com/v1",
  openai_responses: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  dashscope: "https://dashscope.aliyuncs.com/api/v1",
  lmstudio: "http://localhost:1234/v1",
  anthropic: "https://api.anthropic.com"
};

/** 把上游模型名生成为 `[a-z0-9_]` 别名：小写、非字母数字串折叠为单个下划线。 */
export function slugifyModelAlias(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "model";
}

/** 在已使用集合中为别名分配唯一变体：`base`、`base_2`、`base_3` …。 */
function makeUniqueAlias(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) {
    return base;
  }
  let candidate = "";
  for (let index = 2; ; index += 1) {
    candidate = `${base}_${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/** 生成该供应商类型可配置的模型能力草案，字段与 `llmCatalogFileSchema` 的供应商变体一致。 */
export function createProviderModelCapabilityDraft(providerType: LlmProviderType): Record<string, string | boolean> {
  const definition = llmProviderDefinitions[providerType];
  const capabilities: Record<string, string | boolean> = {
    modelType: "chat",
    supportsThinking: false,
    thinkingControllable: true,
    supportsVision: false,
    supportsAudioInput: false,
    supportsTools: true,
    preserveThinking: false
  };
  if (definition.search !== "none") {
    capabilities.supportsSearch = false;
  }
  return capabilities;
}

/**
 * 解析模型清单接口地址。
 * OpenAI 兼容协议（openai / openai_responses / deepseek / dashscope / lmstudio）走 `{baseUrl}/models`，
 * Anthropic 走 `{baseUrl}/v1/models`（该接口默认分页，固定请求 `?limit=1000` 取全量）；
 * DashScope 的推广地址使用 compatible-mode 前缀。
 * deepseek 用户可配置 Anthropic 兼容端点（`…/anthropic`），此时先归一化到 OpenAI 兼容根再拼 `/models`。
 */
export function resolveProviderModelListEndpoint(provider: {
  type: LlmProviderType;
  baseUrl?: string;
}): { endpoint: string } | { unsupported: true; reason: string } {
  const defaultBase = DEFAULT_MODEL_LIST_BASE_URLS[provider.type];
  if (!defaultBase) {
    return {
      unsupported: true,
      reason: `供应商类型 ${provider.type} 暂不支持自动拉取模型清单`
    };
  }
  const resolvedBase = (provider.baseUrl ?? defaultBase).replace(/\/+$/, "");
  if (provider.type === "deepseek") {
    const openAiBase = resolvedBase.replace(/\/anthropic\/?$/, "");
    return { endpoint: `${openAiBase}/models` };
  }
  if (provider.type === "dashscope") {
    const compatibleBase = resolvedBase.replace(/\/api\/v1\/?$/, "/compatible-mode/v1");
    return { endpoint: `${compatibleBase}/models` };
  }
  const suffix = provider.type === "anthropic" ? "/v1/models?limit=1000" : "/models";
  return { endpoint: `${resolvedBase}${suffix}` };
}

function buildModelListHeaders(provider: { type: LlmProviderType; apiKey?: string }): Record<string, string> {
  if (provider.type === "anthropic") {
    return {
      "x-api-key": provider.apiKey ?? "",
      "anthropic-version": "2023-06-01"
    };
  }
  return {
    Authorization: `Bearer ${provider.apiKey ?? ""}`
  };
}

/**
 * 把上游模型 id 列表转换为可导入的模型槽位：
 * 已存在同名上游模型的条目沿用现有别名并标记为更新，其余条目生成 `[a-z0-9_]` 别名并去重。
 */
export function stageProviderModels(
  ids: readonly string[],
  providerType: LlmProviderType,
  existingModels: Readonly<Record<string, Record<string, unknown>>>
): ProviderModelSlot[] {
  const usedAliases = new Set(Object.keys(existingModels));
  const entries = new Map<string, { alias: string; profile: Record<string, unknown> }>();

  for (const [alias, profile] of Object.entries(existingModels)) {
    const upstreamModel = profile.upstreamModel;
    if (typeof upstreamModel === "string" && upstreamModel && !entries.has(upstreamModel)) {
      entries.set(upstreamModel, { alias, profile });
    }
  }

  const seenUpstreamModels = new Set<string>();
  const slots: ProviderModelSlot[] = [];
  for (const upstreamModel of ids) {
    if (seenUpstreamModels.has(upstreamModel)) {
      continue;
    }
    seenUpstreamModels.add(upstreamModel);

    const existing = entries.get(upstreamModel);
    if (existing) {
      // 已存在模型沿用其别名，能力草案从现有配置继承，避免重导入静默重置能力。
      const capabilities = createProviderModelCapabilityDraft(providerType);
      for (const key of Object.keys(capabilities)) {
        const existingValue = existing.profile[key];
        if (existingValue !== undefined) {
          (capabilities as Record<string, string | boolean>)[key] = existingValue as string | boolean;
        }
      }
      slots.push({
        upstreamModel,
        alias: existing.alias,
        exists: true,
        capabilities
      });
      continue;
    }
    const base = slugifyModelAlias(upstreamModel);
    const alias = makeUniqueAlias(base, usedAliases);
    usedAliases.add(alias);
    slots.push({
      upstreamModel,
      alias,
      exists: false,
      capabilities: createProviderModelCapabilityDraft(providerType)
    });
  }
  return slots;
}

function parseModelListPayload(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new Error("模型清单接口响应格式不正确：缺少 data 数组");
  }
  const ids: string[] = [];
  for (const item of data as Array<{ id?: unknown }>) {
    const id = item?.id;
    if (typeof id !== "string" || !id.trim()) {
      continue;
    }
    ids.push(id.trim());
  }
  return ids;
}

/** 从供应商模型清单接口拉取可用模型并生成为可导入槽位；网络或协议错误抛出带中文说明的 Error。 */
export async function listProviderModelSlots(input: {
  provider: LlmCatalogProviderFile;
  config: AppConfig;
  fetchTimeoutMs?: number;
}): Promise<ProviderModelListResult> {
  const endpointResult = resolveProviderModelListEndpoint(input.provider);
  if ("unsupported" in endpointResult) {
    return {
      kind: "unsupported",
      providerType: input.provider.type,
      reason: endpointResult.reason
    };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    input.fetchTimeoutMs ?? MODEL_LIST_TIMEOUT_MS
  );

  try {
    const response = await fetchWithProxy(input.config, "llm", endpointResult.endpoint, {
      method: "GET",
      headers: buildModelListHeaders(input.provider),
      signal: controller.signal
    }, {
      providerProxy: input.provider.proxy
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `模型清单接口返回 ${response.status} ${response.statusText}${body ? `：${body.slice(0, 400)}` : ""}`
      );
    }
    const payload = await response.json().catch(() => null);
    const ids = parseModelListPayload(payload);
    return {
      kind: "ok",
      providerType: input.provider.type,
      endpoint: endpointResult.endpoint,
      models: stageProviderModels(ids, input.provider.type, input.provider.models)
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("拉取模型清单超时");
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}