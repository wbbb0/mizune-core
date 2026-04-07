import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { getDispatcherForUrl } from "../../proxy/index.ts";
import { WebHttpClient } from "../browser/httpClient.ts";
import { AliyunIqsUnifiedSearchProvider } from "./aliyunIqsUnifiedSearchProvider.ts";
import { GoogleGroundingProvider } from "./googleGroundingProvider.ts";
import type { SearchProvider, SearchProviderRequest, SearchResult, SearchResultEntry } from "./types.ts";

const MAX_SEARCH_RESULTS = 10;
const MAX_SEARCH_REFERENCES = 256;

interface SearchReference {
  refId: string;
  url: string;
}

export class SearchService {
  private providers = new Map<string, SearchProvider>();
  private readonly references = new Map<string, SearchReference>();
  private nextSearchRef = 1;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.providers = createProviders(config, logger);
  }

  reloadConfig(): void {
    this.providers = createProviders(this.config, this.logger);
  }

  isEnabled(providerId?: string): boolean {
    if (providerId) {
      return this.providers.has(providerId);
    }
    return this.providers.size > 0;
  }

  async searchGoogleGrounding(query: string): Promise<SearchResult> {
    return this.search({
      provider: "google_grounding",
      query
    });
  }

  async searchAliyunIqsLiteAdvanced(query: string, options?: Record<string, unknown>): Promise<SearchResult> {
    return this.search({
      provider: "aliyun_iqs_lite_advanced",
      query,
      ...(options ? { options } : {})
    });
  }

  async search(input: SearchProviderRequest & { provider: string }): Promise<SearchResult> {
    const normalizedProvider = String(input.provider ?? "").trim();
    const normalizedQuery = String(input.query ?? "").trim();
    if (!normalizedQuery) {
      throw new Error("query is required");
    }
    if (!normalizedProvider) {
      throw new Error("provider is required");
    }

    const provider = this.providers.get(normalizedProvider);
    if (!provider) {
      throw new Error(`Search provider is disabled or unknown: ${normalizedProvider}`);
    }

    const providerResult = await provider.search({
      query: normalizedQuery,
      ...(input.options ? { options: input.options } : {})
    });
    const results = providerResult.sources
      .slice(0, MAX_SEARCH_RESULTS)
      .map((source) => {
        const refId = this.createSearchRef(source.url);
        return {
          ...source,
          ref_id: refId
        } satisfies SearchResultEntry;
      });

    return {
      ok: true,
      provider: providerResult.provider,
      query: providerResult.query,
      answer: providerResult.answer,
      webSearchQueries: providerResult.webSearchQueries,
      results,
      responseId: providerResult.responseId,
      modelVersion: providerResult.modelVersion,
      usage: providerResult.usage,
      meta: providerResult.meta
    };
  }

  resolveReference(refId: string): string | null {
    return this.references.get(String(refId ?? "").trim())?.url ?? null;
  }

  private createSearchRef(url: string): string {
    const refId = `search_${this.nextSearchRef}`;
    this.nextSearchRef += 1;
    this.references.set(refId, { refId, url });
    trimMap(this.references, MAX_SEARCH_REFERENCES);
    return refId;
  }
}

function createProviders(config: AppConfig, logger: Logger): Map<string, SearchProvider> {
  const providers = new Map<string, SearchProvider>();

  if (config.search.googleGrounding.enabled) {
    const provider = new GoogleGroundingProvider({
      apiKey: config.search.googleGrounding.apiKey,
      model: config.search.googleGrounding.model,
      timeoutMs: config.search.googleGrounding.timeoutMs,
      maxSources: config.search.googleGrounding.maxSources,
      resolveRedirectUrls: config.search.googleGrounding.resolveRedirectUrls
    }, createHttpClient(config, config.search.googleGrounding.proxy), logger);
    providers.set(provider.id, provider);
  }

  if (config.search.aliyunIqs.enabled) {
    const provider = new AliyunIqsUnifiedSearchProvider({
      apiKey: config.search.aliyunIqs.apiKey,
      timeoutMs: config.search.aliyunIqs.timeoutMs,
      defaultNumResults: config.search.aliyunIqs.defaultNumResults,
      maxNumResults: config.search.aliyunIqs.maxNumResults,
      defaultIncludeMainText: config.search.aliyunIqs.defaultIncludeMainText,
      defaultIncludeMarkdownText: config.search.aliyunIqs.defaultIncludeMarkdownText
    }, createHttpClient(config, config.search.aliyunIqs.proxy));
    providers.set(provider.id, provider);
  }

  return providers;
}

function createHttpClient(config: AppConfig, searchProxyEnabled: boolean): WebHttpClient {
  return new WebHttpClient({
    getDispatcher: (url) => getDispatcherForUrl(config, "search", url, { searchProxyEnabled })
  });
}

function trimMap<T>(map: Map<string, T>, maxSize: number): void {
  while (map.size > maxSize) {
    const firstKey = map.keys().next().value;
    if (!firstKey) {
      break;
    }
    map.delete(firstKey);
  }
}
