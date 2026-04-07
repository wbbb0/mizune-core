import type { Logger } from "pino";
import type { ProviderSearchResult, SearchProvider, SearchProviderRequest, SearchSource, SearchUsage } from "./types.ts";
import { WebHttpClient } from "../browser/httpClient.ts";

interface GoogleGroundingProviderConfig {
  apiKey?: string | undefined;
  model: string;
  timeoutMs: number;
  maxSources: number;
  resolveRedirectUrls: boolean;
}

interface GoogleGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
      webSearchQueries?: string[];
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    toolUsePromptTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
  error?: {
    message?: string;
  };
}

export class GoogleGroundingProvider implements SearchProvider {
  readonly id = "google_grounding";

  constructor(
    private readonly config: GoogleGroundingProviderConfig,
    private readonly httpClient: WebHttpClient,
    private readonly logger: Logger
  ) {}

  async search(input: SearchProviderRequest): Promise<ProviderSearchResult> {
    const query = String(input.query ?? "").trim();
    if (!query) {
      throw new Error("query is required");
    }

    if (!this.config.apiKey) {
      throw new Error("Google grounding API key is not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.config.model)}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`;
      const response = await this.httpClient.fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: query
            }]
          }],
          tools: [{
            google_search: {}
          }]
        }),
        signal: controller.signal
      });

      const payload = await response.json() as GoogleGenerateContentResponse;
      if (!response.ok) {
        throw new Error(payload.error?.message || `Google grounding API error: ${response.status} ${response.statusText}`);
      }

      const candidate = payload.candidates?.[0];
      const answer = (candidate?.content?.parts ?? [])
        .map((part) => String(part.text ?? "").trim())
        .filter(Boolean)
        .join("\n\n")
        .trim();

      const rawSources = (candidate?.groundingMetadata?.groundingChunks ?? [])
        .flatMap((chunk) => {
          const uri = String(chunk.web?.uri ?? "").trim();
          const title = String(chunk.web?.title ?? "").trim();
          return uri && title ? [{ redirectUrl: uri, title }] : [];
        });

      const uniqueSources = dedupeSources(rawSources).slice(0, this.config.maxSources);
      const sources = await Promise.all(uniqueSources.map(async (item): Promise<SearchSource> => {
        const resolvedUrl = this.config.resolveRedirectUrls
          ? await this.httpClient.resolveRedirectUrl(item.redirectUrl).catch((error: unknown) => {
              this.logger.warn(
                {
                  redirectUrl: item.redirectUrl,
                  error: error instanceof Error ? error.message : String(error)
                },
                "search_redirect_resolve_failed"
              );
              return item.redirectUrl;
            })
          : item.redirectUrl;
        return {
          title: item.title,
          url: resolvedUrl,
          redirectUrl: item.redirectUrl,
          host: safeHost(resolvedUrl),
          snippet: null,
          summary: null,
          publishedTime: null,
          mainText: null,
          markdownText: null,
          siteName: null,
          score: null,
          images: []
        };
      }));

      return {
        ok: true,
        provider: "google_grounding",
        query,
        answer,
        webSearchQueries: candidate?.groundingMetadata?.webSearchQueries ?? [],
        sources,
        responseId: payload.responseId ?? null,
        modelVersion: payload.modelVersion ?? null,
        usage: {
          promptTokenCount: numberOrNull(payload.usageMetadata?.promptTokenCount),
          candidatesTokenCount: numberOrNull(payload.usageMetadata?.candidatesTokenCount),
          totalTokenCount: numberOrNull(payload.usageMetadata?.totalTokenCount),
          toolUsePromptTokenCount: numberOrNull(payload.usageMetadata?.toolUsePromptTokenCount),
          thoughtsTokenCount: numberOrNull(payload.usageMetadata?.thoughtsTokenCount),
          searchTimeMs: null
        } satisfies SearchUsage,
        meta: null
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function dedupeSources(items: Array<{ redirectUrl: string; title: string }>): Array<{ redirectUrl: string; title: string }> {
  const seen = new Set<string>();
  const deduped: Array<{ redirectUrl: string; title: string }> = [];
  for (const item of items) {
    const key = `${item.redirectUrl}::${item.title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
