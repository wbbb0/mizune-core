import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { LlmProviderType } from "#config/llmProviderDefinitions.ts";
import { supportsNativeDecision, supportsNativeVideoInput } from "#config/llmProviderDefinitions.ts";
import { fetchWithProxy, resolveProxyUrls } from "#services/proxy/index.ts";
import { readBoundedProviderBody } from "./providerResponseBody.ts";
import { fillMissingModelFields, type DiscoveredModel } from "./modelDiscoveryMetadata.ts";
import type { ModelDiscoveryInput, NativeModelDiscoveryResult } from "./modelDiscoveryTypes.ts";
import { resolveProviderModelListEndpoint } from "./nativeModelDiscovery.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json?type=all";
const CACHE_TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_CACHE_ENTRIES = 4;
type ObjectValue = Record<string, unknown>;
type Catalog = Record<string, { api?: string | undefined; models: ObjectValue }>;
type LoadResult = { catalog?: Catalog | undefined; warning?: string | undefined };
type CacheEntry = LoadResult & { expiresAt: number; retryAt: number; pending?: Promise<LoadResult> | undefined };
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const positive = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const defined = (value: ObjectValue): ObjectValue => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
const bool = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;

export function parseModelsDevCatalog(payload: unknown): Catalog {
  const catalog: Catalog = Object.create(null);
  for (const [id, raw] of Object.entries(object(payload))) {
    const provider = object(raw);
    if (Object.keys(object(provider.models)).length === 0) continue;
    catalog[id] = { api: typeof provider.api === "string" ? provider.api : undefined, models: object(provider.models) };
  }
  if (Object.keys(catalog).length === 0) throw new Error("models.dev 目录格式无效");
  return catalog;
}

const PROVIDER_IDS: Partial<Record<LlmProviderType, string>> = {
  openai: "openai", openrouter: "openrouter", anthropic: "anthropic", deepseek: "deepseek", google: "google", lmstudio: "lmstudio"
};
const OFFICIAL_ENDPOINTS: Record<string, string> = {
  "https://api.openai.com/v1": "openai", "https://api.anthropic.com": "anthropic", "https://generativelanguage.googleapis.com/v1beta": "google"
};
const normalizeEndpoint = (url: string): string => url.replace(/\/+$/, "");

/** 精确地址匹配；专用协议可以通过类型表明身份，自定义兼容网关可以显式声明。 */
export function resolveModelsDevProvider(catalog: Catalog, input: ModelDiscoveryInput): string | undefined {
  if (input.provider.modelsDevProvider) return input.provider.modelsDevProvider;
  const resolved = resolveProviderModelListEndpoint(input.provider);
  if (!("unsupported" in resolved)) {
    const endpoint = normalizeEndpoint(resolved.endpoint.replace(/\/models(?:\?.*)?$/, ""));
    const matches = Object.entries(catalog).filter(([, provider]) => provider.api && normalizeEndpoint(provider.api) === endpoint).map(([id]) => id);
    if (matches.length === 1) return matches[0];
    if (OFFICIAL_ENDPOINTS[endpoint]) return OFFICIAL_ENDPOINTS[endpoint];
  }
  return PROVIDER_IDS[input.provider.type];
}

/** 只映射应用能表达且协议已实现的能力，不把媒体输出推断为独立媒体 API。 */
export function modelsDevModelProfile(raw: unknown, providerType: LlmProviderType): ObjectValue {
  const model = object(raw);
  const modalities = object(model.modalities);
  const input = strings(modalities.input);
  const output = strings(modalities.output);
  const limit = object(model.limit);
  const profile: ObjectValue = defined({ displayName: typeof model.name === "string" && model.name.trim() ? model.name : undefined });
  if ((model.type === undefined || model.type === "chat") && output?.includes("text")) {
    const reasoningOptions = Array.isArray(model.reasoning_options) ? model.reasoning_options.map(object) : [];
    const canDisable = reasoningOptions.some(option => option.type === "toggle" || strings(option.values)?.some(value => value === "none" || value === "off"));
    profile.chat = {
      limits: defined({ contextTokens: positive(limit.context), maxInputTokens: positive(limit.input), maxOutputTokens: positive(limit.output) }),
      capabilities: defined({
        supportsVision: input ? input.includes("image") : undefined,
        supportsVideoInput: input && supportsNativeVideoInput(providerType) ? input.includes("video") : undefined,
        supportsAudioInput: input && providerType !== "openai" ? input.includes("audio") : undefined,
        supportsTools: bool(model.tool_call), supportsThinking: bool(model.reasoning),
        supportsStructuredOutput: bool(model.structured_output),
        thinkingControllable: canDisable ? true : undefined
      })
    };
  } else if (model.type === "embedding") {
    profile.embedding = { limits: defined({ maxInputTokens: positive(limit.input) ?? positive(limit.context) }) };
  } else if (model.type === "decision" && supportsNativeDecision(providerType)) {
    profile.decision = {};
  } else if (model.type === "image" && providerType === "openai") {
    // OpenAI 专用接入实现 Images API；其他网关仍需原生端点声明。
    profile.image = { capabilities: defined({ referenceImages: input ? input.includes("image") : undefined }) };
  } else if (model.type === "speech" && providerType === "openai") {
    profile.speech = {};
  } else if (model.type === "transcription" && providerType === "openai") {
    profile.transcription = {};
  }
  return profile;
}

export function supplementModelsDevMetadata(models: DiscoveredModel[], catalog: Catalog, providerId: string, providerType: LlmProviderType): DiscoveredModel[] {
  if (!Object.hasOwn(catalog, providerId)) return models;
  const provider = catalog[providerId]!;
  const operations = ["chat", "embedding", "image", "transcription", "speech", "decision"];
  const nativeProfiles = new Map<string, ObjectValue>();
  for (const model of models) nativeProfiles.set(model.id, fillMissingModelFields(nativeProfiles.get(model.id) ?? {}, model.profile));
  const supplements: DiscoveredModel[] = [];
  for (const [id, native] of nativeProfiles) {
    if (!Object.hasOwn(provider.models, id)) continue;
    const profile = modelsDevModelProfile(provider.models[id], providerType);
    // 原生清单已明确用途时，第三方目录只能补该用途的字段。
    const known = operations.filter(key => Object.hasOwn(native, key));
    if (known.length) for (const operation of operations) if (!known.includes(operation)) delete profile[operation];
    if (Object.keys(profile).length) supplements.push({ id, profile, source: `${MODELS_DEV_URL}#${providerId}/${id}` });
  }
  return [...models, ...supplements];
}

/** 每个数据目录及代理路径共享一小时磁盘/内存缓存与在途请求。 */
export class ModelsDevCatalog {
  private readonly cache = new Map<string, CacheEntry>();
  constructor(private readonly fetchCatalog = fetchModelsDevCatalog, private readonly now = Date.now) {}

  async enrich(result: Extract<NativeModelDiscoveryResult, { kind: "ok" }>, input: ModelDiscoveryInput): Promise<NativeModelDiscoveryResult> {
    input.abortSignal?.throwIfAborted();
    const loaded = await waitForCatalog(this.load(input), input.abortSignal);
    input.abortSignal?.throwIfAborted();
    const warnings = [...result.warnings, ...(loaded.warning ? [loaded.warning] : [])];
    if (!loaded.catalog) return { ...result, warnings };
    const id = resolveModelsDevProvider(loaded.catalog, input);
    if (id && !Object.hasOwn(loaded.catalog, id) && input.provider.modelsDevProvider) warnings.push(`models.dev 未收录供应商 ${id}，已保留原生模型信息`);
    return { ...result, warnings, models: id ? supplementModelsDevMetadata(result.models, loaded.catalog, id, input.provider.type) : result.models };
  }

  private load(input: ModelDiscoveryInput): Promise<LoadResult> {
    const route = JSON.stringify(resolveProxyUrls(input.config, "llm", { providerProxy: input.provider.proxy }));
    // 文件名只含代理路径的摘要，不落盘代理凭据。
    const routeHash = createHash("sha256").update(route).digest("hex");
    const key = resolve(input.config.dataDir, "cache", "models-dev", `${routeHash}.json`);
    let entry = this.cache.get(key);
    if (!entry) {
      entry = { expiresAt: 0, retryAt: 0 };
      this.cache.set(key, entry);
    }
    if (entry.pending) return entry.pending;
    if (this.now() < entry.expiresAt || this.now() < entry.retryAt) return Promise.resolve(entry);
    const current = entry;
    current.pending = this.refresh(current, input, key).finally(() => {
      current.pending = undefined;
      this.trim();
    });
    this.trim();
    return current.pending;
  }

  private trim(): void {
    // 在途请求可临时超过上限，完成后收缩，避免保留多份大目录。
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= MAX_CACHE_ENTRIES) break;
      if (!entry.pending) this.cache.delete(key);
    }
  }

  private async refresh(entry: CacheEntry, input: ModelDiscoveryInput, file: string): Promise<LoadResult> {
    // 也检查其他进程写入的新缓存，服务重启后仍复用原始获取时间。
    const stored = await readCatalogCache(file, this.now());
    if (stored && stored.fetchedAt + CACHE_TTL_MS > entry.expiresAt) {
      entry.catalog = stored.catalog;
      entry.expiresAt = stored.fetchedAt + CACHE_TTL_MS;
      entry.warning = undefined;
    }
    if (this.now() < entry.expiresAt) return entry;
    try {
      const catalog = await this.fetchCatalog(input);
      const fetchedAt = this.now();
      entry.catalog = catalog;
      entry.expiresAt = fetchedAt + CACHE_TTL_MS;
      entry.retryAt = 0;
      entry.warning = undefined;
      try { await writeCatalogCache(file, { fetchedAt, catalog }); }
      catch { entry.warning = "models.dev 本地缓存写入失败，本次元信息仍可使用"; }
    } catch {
      entry.retryAt = this.now() + RETRY_MS;
      entry.warning = entry.catalog ? "models.dev 暂不可用，使用上次缓存的元信息" : "models.dev 暂不可用，已保留原生模型信息";
    }
    return entry;
  }
}

type StoredCatalog = { fetchedAt: number; catalog: Catalog };
async function readCatalogCache(file: string, now: number): Promise<StoredCatalog | undefined> {
  try {
    const handle = await open(file, "r");
    try {
      if ((await handle.stat()).size > 16 * 1024 * 1024) return undefined;
      const stored = object(JSON.parse(await handle.readFile("utf8")));
      const fetchedAt = positive(stored.fetchedAt);
      if (!fetchedAt || fetchedAt > now) return undefined;
      return { fetchedAt, catalog: parseModelsDevCatalog(stored.catalog) };
    } finally { await handle.close(); }
  } catch { return undefined; }
}

async function writeCatalogCache(file: string, stored: StoredCatalog): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(stored), { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function fetchModelsDevCatalog(input: ModelDiscoveryInput): Promise<Catalog> {
  // 公共目录请求不携带供应商密钥、模型清单或其他业务数据。
  const response = await fetchWithProxy(input.config, "llm", MODELS_DEV_URL, {
    method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  }, { providerProxy: input.provider.proxy });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`models.dev HTTP ${response.status}`); }
  return parseModelsDevCatalog(JSON.parse((await readBoundedProviderBody(response, 16 * 1024 * 1024)).toString("utf8")));
}

async function waitForCatalog<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([task, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export const modelsDevCatalog = new ModelsDevCatalog();
