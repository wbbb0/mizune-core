import { WebHttpClient } from "../browser/httpClient.ts";
import type { ProviderSearchResult, SearchProvider, SearchProviderRequest, SearchSource, SearchUsage } from "./types.ts";

interface AliyunIqsUnifiedSearchProviderConfig {
  apiKey?: string | undefined;
  timeoutMs: number;
  defaultNumResults: number;
  maxNumResults: number;
  defaultIncludeMainText: boolean;
  defaultIncludeMarkdownText: boolean;
}

interface AliyunIqsPageItem {
  title?: string;
  link?: string;
  snippet?: string;
  publishedTime?: string;
  mainText?: string | null;
  markdownText?: string | null;
  hostname?: string | null;
  summary?: string | null;
  rerankScore?: number | null;
  images?: string[] | null;
}

interface AliyunIqsUnifiedSearchResponse {
  requestId?: string;
  pageItems?: AliyunIqsPageItem[];
  sceneItems?: unknown[];
  searchInformation?: {
    searchTime?: number;
  };
  queryContext?: Record<string, unknown>;
  costCredits?: Record<string, unknown>;
  message?: string;
  code?: string;
}

const LITE_ADVANCED_ENDPOINT = "https://cloud-iqs.aliyuncs.com/search/unified";

export class AliyunIqsUnifiedSearchProvider implements SearchProvider {
  readonly id = "aliyun_iqs_lite_advanced";

  constructor(
    private readonly config: AliyunIqsUnifiedSearchProviderConfig,
    private readonly httpClient: WebHttpClient
  ) {}

  async search(input: SearchProviderRequest): Promise<ProviderSearchResult> {
    const query = String(input.query ?? "").trim();
    if (!query) {
      throw new Error("query is required");
    }
    if (!this.config.apiKey) {
      throw new Error("Aliyun IQS API key is not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await this.httpClient.fetch(LITE_ADVANCED_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(buildRequestBody(query, input.options, this.config)),
        signal: controller.signal
      });

      const payload = await response.json() as AliyunIqsUnifiedSearchResponse;
      if (!response.ok) {
        throw new Error(payload.message || payload.code || `Aliyun IQS API error: ${response.status} ${response.statusText}`);
      }

      const sources = (payload.pageItems ?? [])
        .flatMap((item) => toSearchSource(item));

      return {
        ok: true,
        provider: this.id,
        query,
        answer: null,
        webSearchQueries: [],
        sources,
        responseId: stringOrNull(payload.requestId),
        modelVersion: "LiteAdvanced",
        usage: {
          promptTokenCount: null,
          candidatesTokenCount: null,
          totalTokenCount: null,
          toolUsePromptTokenCount: null,
          thoughtsTokenCount: null,
          searchTimeMs: numberOrNull(payload.searchInformation?.searchTime)
        } satisfies SearchUsage,
        meta: {
          sceneItems: Array.isArray(payload.sceneItems) ? payload.sceneItems : [],
          searchInformation: payload.searchInformation ?? null,
          queryContext: payload.queryContext ?? null,
          costCredits: payload.costCredits ?? null
        }
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildRequestBody(
  query: string,
  options: Record<string, unknown> | undefined,
  config: AliyunIqsUnifiedSearchProviderConfig
): Record<string, unknown> {
  const numResults = clampInteger(options?.numResults, 1, config.maxNumResults, config.defaultNumResults);
  const includeSites = normalizeSiteList(options?.includeSites);
  const excludeSites = normalizeSiteList(options?.excludeSites);
  const startPublishedDate = normalizeDateString(options?.startPublishedDate);
  const endPublishedDate = normalizeDateString(options?.endPublishedDate);
  const timeRange = normalizeString(options?.timeRange);
  const includeMainText = typeof options?.includeMainText === "boolean"
    ? options.includeMainText
    : config.defaultIncludeMainText;
  const includeMarkdownText = typeof options?.includeMarkdownText === "boolean"
    ? options.includeMarkdownText
    : config.defaultIncludeMarkdownText;

  return {
    query,
    engineType: "LiteAdvanced",
    ...(timeRange ? { timeRange } : {}),
    contents: {
      mainText: includeMainText,
      markdownText: includeMarkdownText,
      summary: false,
      rerankScore: true
    },
    advancedParams: {
      numResults: String(numResults),
      ...(includeSites.length > 0 ? { includeSites: includeSites.join(",") } : {}),
      ...(excludeSites.length > 0 ? { excludeSites: excludeSites.join(",") } : {}),
      ...(startPublishedDate ? { startPublishedDate } : {}),
      ...(endPublishedDate ? { endPublishedDate } : {})
    }
  };
}

function toSearchSource(item: AliyunIqsPageItem): SearchSource[] {
  const url = String(item.link ?? "").trim();
  const title = String(item.title ?? "").trim();
  if (!url || !title) {
    return [];
  }

  return [{
    title,
    url,
    redirectUrl: null,
    host: safeHost(url),
    snippet: stringOrNull(item.snippet),
    summary: stringOrNull(item.summary),
    publishedTime: stringOrNull(item.publishedTime),
    mainText: stringOrNull(item.mainText),
    markdownText: stringOrNull(item.markdownText),
    siteName: stringOrNull(item.hostname),
    score: numberOrNull(item.rerankScore),
    images: Array.isArray(item.images)
      ? item.images.map((value) => String(value ?? "").trim()).filter(Boolean)
      : []
  }];
}

function normalizeString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeDateString(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized && /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function normalizeSiteList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 100);
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
