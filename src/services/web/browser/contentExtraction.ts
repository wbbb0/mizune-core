import type { BrowserElement, BrowserLineMatch, BrowserLink, BrowserRenderResult, BrowserSnapshot } from "./types.ts";

const DEFAULT_WINDOW_LINES = 40;
const WINDOW_PADDING_LINES = 10;
const LINE_TARGET_LENGTH = 160;
const MAX_PAGE_LINKS = 40;
const MAX_PAGE_ELEMENTS = 40;
const MAX_RENDERED_LINKS = 20;
const MAX_RENDERED_ELEMENTS = 24;

interface ExtractedPageContent {
  title: string | null;
  text: string;
  links: Array<{ text: string; url: string }>;
  truncated: boolean;
}

export function renderSnapshot(
  resourceId: string,
  backend: "playwright",
  snapshot: BrowserSnapshot,
  line?: number
): BrowserRenderResult {
  const startLine = line
    ? clamp(line - WINDOW_PADDING_LINES, 1, Math.max(snapshot.lines.length, 1))
    : 1;
  const endLine = line
    ? clamp(startLine + DEFAULT_WINDOW_LINES - 1, startLine, Math.max(snapshot.lines.length, startLine))
    : Math.min(snapshot.lines.length, DEFAULT_WINDOW_LINES);

  const renderedLines = snapshot.lines.length === 0
    ? []
    : snapshot.lines
        .slice(startLine - 1, endLine)
        .map((item, index) => formatNumberedLine(startLine + index, item));
  const renderedElements = snapshot.elements
    .slice(0, MAX_RENDERED_ELEMENTS)
    .map((item) => compactBrowserElement(item));
  const renderedElementIds = new Set(renderedElements.map((item) => item.id));

  return {
    resource_id: resourceId,
    backend,
    profile_id: snapshot.profileId,
    requestedUrl: snapshot.requestedUrl,
    resolvedUrl: snapshot.resolvedUrl,
    title: snapshot.title,
    contentType: snapshot.contentType,
    lines: renderedLines,
    links: snapshot.links
      .filter((item) => renderedElementIds.has(item.id))
      .slice(0, MAX_RENDERED_LINKS),
    elements: renderedElements,
    lineStart: renderedLines.length > 0 ? startLine : 0,
    lineEnd: renderedLines.length > 0 ? startLine + renderedLines.length - 1 : 0,
    truncated: snapshot.truncated
  };
}

function compactBrowserElement(element: BrowserElement): BrowserElement {
  const whySelected = Array.isArray(element.why_selected) ? element.why_selected : [];
  const sourceUrls = Array.isArray(element.source_urls) ? element.source_urls : [];
  return {
    id: element.id,
    kind: element.kind,
    label: element.label,
    why_selected: whySelected.slice(0, 2),
    action: element.action,
    ...(element.name ? { name: element.name } : {}),
    ...(element.text && element.text !== element.name ? { text: element.text } : {}),
    ...(element.role ? { role: element.role } : {}),
    ...(element.tag !== "a" || element.kind !== "link" ? { tag: element.tag } : {}),
    ...(element.type ? { type: element.type } : {}),
    ...(element.href ? { href: element.href } : {}),
    ...(element.placeholder ? { placeholder: element.placeholder } : {}),
    ...(element.value_preview ? { value_preview: element.value_preview } : {}),
    ...(element.checked != null ? { checked: element.checked } : {}),
    ...(element.selected != null ? { selected: element.selected } : {}),
    ...(element.expanded != null ? { expanded: element.expanded } : {}),
    ...(element.locator_hint ? { locator_hint: element.locator_hint } : {}),
    ...(element.has_image ? { has_image: true } : {}),
    ...(element.in_main_content ? { in_main_content: true } : {}),
    ...(element.media_url ? { media_url: element.media_url } : {}),
    ...(element.poster_url ? { poster_url: element.poster_url } : {}),
    ...(sourceUrls.length > 0 ? { source_urls: sourceUrls.slice(0, 3) } : {}),
    ...(element.disabled ? { disabled: true } : {}),
    ...(element.visibility !== "visible" ? { visibility: element.visibility } : {})
  } as BrowserElement;
}

export function findMatches(lines: string[], pattern: string): BrowserLineMatch[] {
  const needles = splitFindPattern(pattern);
  if (needles.length === 0) {
    return [];
  }

  const matches: BrowserLineMatch[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index];
    if (!lineText) {
      continue;
    }
    const normalizedLine = lineText.toLowerCase();
    if (!needles.some((needle) => normalizedLine.includes(needle))) {
      continue;
    }
    matches.push({
      lineNumber: index + 1,
      text: formatNumberedLine(index + 1, lineText)
    });
    if (matches.length >= DEFAULT_WINDOW_LINES) {
      break;
    }
  }

  return matches;
}

export function normalizeLineNumber(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
}

export function normalizeWaitMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
}

export function validateHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function isTextLikeContentType(contentType: string | null): boolean {
  if (!contentType) {
    return true;
  }
  const normalized = contentType.toLowerCase();
  return normalized.includes("text/")
    || normalized.includes("application/json")
    || normalized.includes("application/xhtml+xml")
    || normalized.includes("application/xml")
    || normalized.includes("application/javascript");
}

export function extractStaticSnapshot(
  rawText: string,
  contentType: string | null,
  requestedUrl: string,
  resolvedUrl: string,
  maxChars: number
): BrowserSnapshot {
  const extracted = extractReadableContent(rawText, contentType, resolvedUrl, maxChars);
  const links = extracted.links
    .slice(0, MAX_PAGE_LINKS)
    .map((link, index) => ({
      id: index + 1,
      text: link.text,
      url: link.url,
      host: safeHost(link.url)
    } satisfies BrowserLink));
  const elements = links
    .slice(0, MAX_PAGE_ELEMENTS)
    .map((link) => ({
      id: link.id,
      kind: "link",
      label: link.text || link.url,
      why_selected: ["正文链接"],
      role: "link",
      name: link.text,
      tag: "a",
      text: link.text,
      type: null,
      action: "click",
      disabled: false,
      href: link.url,
      placeholder: null,
      value_preview: null,
      checked: null,
      selected: null,
      expanded: null,
      visibility: "visible",
      locator_hint: `a[href*="${safeLocatorFragment(link.url)}"]`,
      has_image: false,
      in_main_content: true,
      media_url: null,
      poster_url: null,
      source_urls: []
    } satisfies BrowserElement));

  return {
    profileId: null,
    requestedUrl,
    resolvedUrl,
    title: extracted.title,
    contentType,
    lines: splitIntoLines(extracted.text, LINE_TARGET_LENGTH),
    links,
    elements,
    truncated: extracted.truncated
  };
}

function safeLocatorFragment(value: string): string {
  return value.replace(/"/g, "");
}

export function splitIntoLines(text: string, targetLength: number): string[] {
  const normalized = cleanWhitespace(text);
  if (!normalized) {
    return [];
  }

  const lines: string[] = [];
  const paragraphs = normalized.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      if (!current) {
        current = word;
        continue;
      }
      if ((current.length + 1 + word.length) <= targetLength) {
        current += ` ${word}`;
        continue;
      }
      lines.push(current);
      current = word;
    }
    if (current) {
      lines.push(current);
    }
  }

  return lines;
}

export function cleanWhitespace(value: string): string {
  return value
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

export function safeHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function splitFindPattern(pattern: string): string[] {
  return pattern
    .split("|")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatNumberedLine(lineNumber: number, text: string): string {
  return `L${lineNumber} ${text}`;
}

function extractReadableContent(
  rawText: string,
  contentType: string | null,
  baseUrl: string,
  maxChars: number
): ExtractedPageContent {
  if (!contentType || contentType.toLowerCase().includes("html") || contentType.toLowerCase().includes("xml")) {
    const titleMatch = rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeHtmlEntities(cleanWhitespace(titleMatch[1] ?? "")) : null;
    const withoutNoise = rawText
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ");
    const links = extractLinks(withoutNoise, baseUrl);
    const stripped = withoutNoise
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
      .replace(/<\/?(article|section|main|nav|header|footer|aside|p|div|li|ul|ol|h[1-6]|br|tr|td|th|table|blockquote|pre)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
    const decoded = decodeHtmlEntities(stripped);
    const normalized = filterNoisyLines(cleanWhitespace(decoded));
    return {
      title,
      text: normalized.slice(0, maxChars),
      links,
      truncated: normalized.length > maxChars
    };
  }

  const normalized = cleanWhitespace(rawText);
  return {
    title: null,
    text: normalized.slice(0, maxChars),
    links: [],
    truncated: normalized.length > maxChars
  };
}

function extractLinks(rawHtml: string, baseUrl: string): Array<{ text: string; url: string }> {
  const results: Array<{ text: string; url: string }> = [];
  const seen = new Set<string>();
  const linkPattern = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(rawHtml)) != null) {
    const href = String(match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!href) {
      continue;
    }

    let resolvedUrl: string;
    try {
      const url = new URL(href, baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        continue;
      }
      resolvedUrl = url.toString();
    } catch {
      continue;
    }

    const text = decodeHtmlEntities(cleanWhitespace(
      String(match[4] ?? "")
        .replace(/<[^>]+>/g, " ")
    ));
    if (!text) {
      continue;
    }

    const key = `${resolvedUrl}::${text}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push({ text, url: resolvedUrl });
    if (results.length >= MAX_PAGE_LINKS) {
      break;
    }
  }

  return results;
}

function filterNoisyLines(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isLikelyNoiseLine(line))
    .join("\n");
}

function isLikelyNoiseLine(line: string): boolean {
  const lower = line.toLowerCase();
  if (lower.startsWith("/*") || lower.startsWith(":root")) {
    return true;
  }
  if (line.includes("--") && (line.includes("rgb") || line.includes("var("))) {
    return true;
  }
  const punctuationRatio = (line.match(/[{}:;,#]/g) ?? []).length / Math.max(line.length, 1);
  return punctuationRatio > 0.12;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (full, digits) => {
      const code = Number(digits);
      return Number.isInteger(code) ? String.fromCodePoint(code) : full;
    });
}
