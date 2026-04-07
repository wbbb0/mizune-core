export interface SearchSource {
  title: string;
  url: string;
  redirectUrl: string | null;
  host: string | null;
  snippet: string | null;
  summary: string | null;
  publishedTime: string | null;
  mainText: string | null;
  markdownText: string | null;
  siteName: string | null;
  score: number | null;
  images: string[];
}

export interface SearchResultEntry extends SearchSource {
  ref_id: string;
}

export interface SearchUsage {
  promptTokenCount: number | null;
  candidatesTokenCount: number | null;
  totalTokenCount: number | null;
  toolUsePromptTokenCount: number | null;
  thoughtsTokenCount: number | null;
  searchTimeMs: number | null;
}

export interface SearchResult {
  ok: true;
  provider: string;
  query: string;
  answer: string | null;
  webSearchQueries: string[];
  results: SearchResultEntry[];
  responseId: string | null;
  modelVersion: string | null;
  usage: SearchUsage;
  meta: Record<string, unknown> | null;
}

export interface ProviderSearchResult {
  ok: true;
  provider: string;
  query: string;
  answer: string | null;
  webSearchQueries: string[];
  sources: SearchSource[];
  responseId: string | null;
  modelVersion: string | null;
  usage: SearchUsage;
  meta: Record<string, unknown> | null;
}

export interface SearchProviderRequest {
  query: string;
  options?: Record<string, unknown>;
}

export interface SearchProvider {
  readonly id: string;
  search(input: SearchProviderRequest): Promise<ProviderSearchResult>;
}
