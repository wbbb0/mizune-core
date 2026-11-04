export interface NativeSearchCitation {
  url: string;
  title: string;
}

/** Only public HTTP links are presentation data; provider payloads remain untouched for replay. */
export function readNativeSearchCitations(metadata: Record<string, unknown> | undefined): NativeSearchCitation[] {
  const values = metadata?.citations;
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values.flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    if (typeof row.url !== "string") return [];
    let url: URL;
    try { url = new URL(row.url); } catch { return []; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || seen.has(url.href)) return [];
    seen.add(url.href);
    return [{ url: url.href, title: typeof row.title === "string" && row.title.trim() ? row.title : url.hostname }];
  });
}

/** All transports receive ordinary links, including clients without provider citation rendering. */
export function renderNativeSearchCitations(text: string, metadata: Record<string, unknown> | undefined): string {
  const citations = readNativeSearchCitations(metadata);
  if (!citations.length) return text;
  const body = text.replace(/cite[^]*/gu, "").trimEnd();
  const sources = citations.map((citation, index) => {
    const label = citation.title.replace(/[\\\[\]\n\r]/g, " ").trim();
    const url = citation.url.replace(/[()<>]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${index + 1}. [${label}](${url})`;
  });
  return `${body}\n\n参考来源：\n${sources.join("\n")}`;
}
