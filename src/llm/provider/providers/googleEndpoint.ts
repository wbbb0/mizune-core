const DEFAULT_BASE = "https://generativelanguage.googleapis.com";

/** Keep proxy path prefixes; strip only the terminal API version / method. */
export function resolveAiStudioEndpoint(rawBaseUrl?: string): { baseUrl: string; apiVersion: string } {
  const url = new URL(rawBaseUrl?.trim() || DEFAULT_BASE);
  if (url.search || url.hash || url.username || url.password) throw new Error("AI Studio baseUrl 不允许包含查询参数、片段或凭据");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/i, "");
  const version = path.match(/\/(v\d+(?:alpha|beta\d*)?)$/i);
  url.pathname = version ? path.slice(0, -version[0].length) : path;
  return { baseUrl: url.href.replace(/\/+$/, ""), apiVersion: version?.[1] ?? "v1beta" };
}

