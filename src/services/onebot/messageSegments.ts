import type { OneBotMessageSegment, OneBotSpecialSegmentSummary } from "./types.ts";

export type MediaSemanticKind = "image" | "emoji";

export interface MentionExtraction {
  mentionedSelf: boolean;
  mentionedAll: boolean;
  userIds: string[];
}

export interface ExtractedMediaSource {
  source: string;
  kind: MediaSemanticKind;
}

export interface ExtractedAudioSource {
  source: string;
}

export interface ExtractedFileSource {
  source: string;
  filename: string | null;
  mimeType: string | null;
}

export interface NormalizedMentionSegment {
  kind: "mention";
  target: "self" | "all" | "user";
  userId?: string;
}

export interface NormalizedOtherSegment {
  kind: "other";
  type: string;
  summary: string;
}

export type NormalizedMessageToolSegment =
  | { kind: "text"; text: string }
  | { kind: "image"; source: string; viewable: boolean; mediaKind: MediaSemanticKind }
  | { kind: "forward"; forwardId: string }
  | { kind: "reply"; messageId: string }
  | NormalizedMentionSegment
  | NormalizedOtherSegment;

export function extractText(segments: OneBotMessageSegment[]): string {
  return segments
    .filter((segment) => segment.type === "text")
    .map((segment) => String(segment.data.text ?? ""))
    .join("");
}

export function extractImageSources(segments: OneBotMessageSegment[]): string[] {
  return extractMediaSources(segments).map((item) => item.source);
}

export function extractAudioSources(segments: OneBotMessageSegment[]): string[] {
  const seen = new Set<string>();
  const audioSources: string[] = [];

  for (const segment of segments) {
    const source = getAudioSource(segment);
    if (!source || seen.has(source)) {
      continue;
    }
    seen.add(source);
    audioSources.push(source);
  }

  return audioSources;
}

export function extractFileSources(segments: OneBotMessageSegment[]): ExtractedFileSource[] {
  const seen = new Set<string>();
  const files: ExtractedFileSource[] = [];
  for (const segment of segments) {
    if (segment.type !== "file") {
      continue;
    }
    const source = getFirstNonEmptyString([
      segment.data.url,
      segment.data.path,
      segment.data.file
    ]);
    if (!source || seen.has(source)) {
      continue;
    }
    seen.add(source);
    files.push({
      source,
      filename: getFirstNonEmptyString([segment.data.name, segment.data.filename, segment.data.file]),
      mimeType: getFirstNonEmptyString([segment.data.mimeType, segment.data.mime_type])
    });
  }
  return files;
}

export function extractSpecialSegments(segments: OneBotMessageSegment[]): OneBotSpecialSegmentSummary[] {
  return segments
    .map((segment) => {
      const summary = summarizeSpecialSegment(segment);
      return summary ? { type: segment.type, summary } : null;
    })
    .filter((item): item is OneBotSpecialSegmentSummary => item != null);
}

export function extractMediaSources(segments: OneBotMessageSegment[]): ExtractedMediaSource[] {
  const seen = new Set<string>();
  const media: ExtractedMediaSource[] = [];

  for (const segment of segments) {
    const source = getImageSource(segment);
    if (!source) {
      continue;
    }
    const kind = getSegmentMediaKind(segment);
    const dedupeKey = `${kind}:${source}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    media.push({ source, kind });
  }

  return media;
}

export function extractForwardIds(segments: OneBotMessageSegment[]): string[] {
  const seen = new Set<string>();
  const forwardIds: string[] = [];

  for (const segment of segments) {
    const forwardId = getForwardId(segment);
    if (!forwardId || seen.has(forwardId)) {
      continue;
    }
    seen.add(forwardId);
    forwardIds.push(forwardId);
  }

  return forwardIds;
}

export function extractReplyMessageId(segments: OneBotMessageSegment[]): string | null {
  for (const segment of segments) {
    const messageId = getReplyMessageId(segment);
    if (messageId) {
      return messageId;
    }
  }
  return null;
}

export function extractMentions(
  segments: OneBotMessageSegment[],
  selfId?: string | number | null
): MentionExtraction {
  const normalizedSelfId = String(selfId ?? "").trim();
  const userIds: string[] = [];
  const seen = new Set<string>();
  let mentionedSelf = false;
  let mentionedAll = false;

  for (const segment of segments) {
    if (segment.type !== "at") {
      continue;
    }

    const userId = String(segment.data.qq ?? "").trim();
    if (!userId) {
      continue;
    }

    if (userId === "all") {
      mentionedAll = true;
      continue;
    }

    if (normalizedSelfId && userId === normalizedSelfId) {
      mentionedSelf = true;
      continue;
    }

    if (seen.has(userId)) {
      continue;
    }
    seen.add(userId);
    userIds.push(userId);
  }

  return {
    mentionedSelf,
    mentionedAll,
    userIds
  };
}

export function normalizeSegmentsForTool(
  segments: OneBotMessageSegment[],
  options?: {
    selfId?: string | number | null;
  }
): NormalizedMessageToolSegment[] {
  const normalizedSelfId = String(options?.selfId ?? "").trim();
  const normalized: NormalizedMessageToolSegment[] = [];

  for (const segment of segments) {
    if (segment.type === "text") {
      const text = String(segment.data.text ?? "");
      if (text) {
        normalized.push({ kind: "text", text });
      }
      continue;
    }

    const imageSource = getImageSource(segment);
    if (imageSource) {
      normalized.push({
        kind: "image",
        source: imageSource,
        mediaKind: getSegmentMediaKind(segment),
        viewable: true
      });
      continue;
    }

    const forwardId = getForwardId(segment);
    if (forwardId) {
      normalized.push({
        kind: "forward",
        forwardId
      });
      continue;
    }

    const replyMessageId = getReplyMessageId(segment);
    if (replyMessageId) {
      normalized.push({
        kind: "reply",
        messageId: replyMessageId
      });
      continue;
    }

    const mention = getMentionTarget(segment, normalizedSelfId);
    if (mention) {
      normalized.push(mention);
      continue;
    }

    normalized.push({
      kind: "other",
      type: segment.type,
      summary: summarizeSegment(segment)
    });
  }

  return normalized;
}

export function getImageSource(segment: OneBotMessageSegment): string | null {
  const isImageSegment = segment.type === "image" || segment.type === "mface";
  if (!isImageSegment) {
    return null;
  }

  return getFirstNonEmptyString([
    segment.data.url,
    segment.data.file,
    segment.data.path,
    segment.data.src
  ]);
}

export function getAudioSource(segment: OneBotMessageSegment): string | null {
  const isAudioSegment = segment.type === "record" || segment.type === "voice" || segment.type === "audio";
  if (!isAudioSegment) {
    return null;
  }

  return getFirstNonEmptyString([
    segment.data.url,
    segment.data.path,
    segment.data.file,
    segment.data.src
  ]);
}

export function getSegmentMediaKind(segment: OneBotMessageSegment): MediaSemanticKind {
  return segment.type === "mface" ? "emoji" : "image";
}

export function getForwardId(segment: OneBotMessageSegment): string | null {
  if (segment.type !== "forward") {
    return null;
  }

  return getFirstNonEmptyString([
    segment.data.id,
    segment.data.resid,
    segment.data.forward_id,
    segment.data.message_id
  ]);
}

export function getReplyMessageId(segment: OneBotMessageSegment): string | null {
  if (segment.type !== "reply") {
    return null;
  }

  return getFirstNonEmptyString([
    segment.data.id,
    segment.data.message_id
  ]);
}

export function getMentionTarget(
  segment: OneBotMessageSegment,
  selfId?: string | null
): NormalizedMentionSegment | null {
  if (segment.type !== "at") {
    return null;
  }

  const userId = String(segment.data.qq ?? "").trim();
  if (!userId) {
    return null;
  }

  if (userId === "all") {
    return {
      kind: "mention",
      target: "all"
    };
  }

  if (selfId && userId === selfId) {
    return {
      kind: "mention",
      target: "self"
    };
  }

  return {
    kind: "mention",
    target: "user",
    userId
  };
}

export function summarizeSegment(segment: OneBotMessageSegment): string {
  const specialSummary = summarizeSpecialSegment(segment);
  if (specialSummary) {
    return specialSummary;
  }

  const data = segment.data && typeof segment.data === "object"
    ? Object.entries(segment.data)
      .slice(0, 3)
      .map(([key, value]) => `${key}=${truncateValue(value)}`)
      .join(", ")
    : "";

  return data ? `${segment.type}(${data})` : segment.type;
}

function summarizeSpecialSegment(segment: OneBotMessageSegment): string | null {
  if (isNativelyHandledSegment(segment)) {
    return null;
  }

  switch (segment.type) {
    case "face":
      return `QQ 表情：id=${getFirstNonEmptyString([segment.data.id, segment.data.face_id]) ?? "unknown"}`;
    case "dice":
      return `骰子：${getFirstNonEmptyString([segment.data.result, segment.data.value, segment.data.num, segment.data.id]) ?? "unknown"}`;
    case "rps":
      return `猜拳：${getFirstNonEmptyString([segment.data.result, segment.data.value, segment.data.id]) ?? "unknown"}`;
    case "poke":
    case "shake":
      return `互动动作：type=${segment.type}${formatKeyValueSuffix({
        target: getFirstNonEmptyString([segment.data.qq, segment.data.user_id, segment.data.target]),
        id: getFirstNonEmptyString([segment.data.id, segment.data.type])
      })}`;
    case "video":
      return `视频：${getFirstNonEmptyString([segment.data.name, segment.data.file, segment.data.url, segment.data.path, segment.data.src]) ?? summarizeSegmentData(segment)}`;
    case "share":
      return `分享：${formatCompactFields([
        getFirstNonEmptyString([segment.data.title]),
        getFirstNonEmptyString([segment.data.content, segment.data.summary]),
        getFirstNonEmptyString([segment.data.url])
      ]) || summarizeSegmentData(segment)}`;
    case "contact":
      return `联系人：${formatCompactFields([
        getFirstNonEmptyString([segment.data.type]),
        getFirstNonEmptyString([segment.data.id, segment.data.qq, segment.data.group_id])
      ]) || summarizeSegmentData(segment)}`;
    case "location":
      return `位置：${formatCompactFields([
        getFirstNonEmptyString([segment.data.title]),
        getFirstNonEmptyString([segment.data.content, segment.data.address]),
        formatLatLon(segment.data.lat ?? segment.data.latitude, segment.data.lon ?? segment.data.lng ?? segment.data.longitude)
      ]) || summarizeSegmentData(segment)}`;
    case "music":
      return `音乐：${formatCompactFields([
        getFirstNonEmptyString([segment.data.title]),
        getFirstNonEmptyString([segment.data.type]),
        getFirstNonEmptyString([segment.data.id, segment.data.url])
      ]) || summarizeSegmentData(segment)}`;
    case "json":
    case "lightapp":
      return `${segment.type === "json" ? "JSON 卡片" : "LightApp 卡片"}：${summarizeRichPayload(segment.data.data ?? segment.data.content ?? segment.data.text ?? segment.data)}`;
    case "markdown":
      return `Markdown：${compactText(getFirstNonEmptyString([segment.data.content, segment.data.text, segment.data.markdown]) ?? summarizeSegmentData(segment), 180)}`;
    case "node":
      return `合并转发节点：${summarizeSegmentData(segment)}`;
    default:
      return `${segment.type}：${summarizeSegmentData(segment)}`;
  }
}

function isNativelyHandledSegment(segment: OneBotMessageSegment): boolean {
  return segment.type === "text"
    || segment.type === "at"
    || getImageSource(segment) != null
    || getAudioSource(segment) != null
    || segment.type === "file"
    || getForwardId(segment) != null
    || getReplyMessageId(segment) != null;
}

function summarizeRichPayload(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return "empty";
  }
  const parsed = parseJsonObject(text);
  if (!parsed) {
    return compactText(text, 180);
  }
  return formatCompactFields([
    getFirstNonEmptyString([parsed.prompt, parsed.title, parsed.app, parsed.desc]),
    getFirstNonEmptyString([parsed.summary, parsed.content, parsed.text]),
    getFirstNonEmptyString([parsed.url, parsed.jumpUrl, parsed.qqdocurl])
  ]) || compactText(JSON.stringify(parsed), 180);
}

function summarizeSegmentData(segment: OneBotMessageSegment): string {
  const entries = Object.entries(segment.data ?? {}).slice(0, 4);
  if (entries.length === 0) {
    return "无附加数据";
  }
  return entries
    .map(([key, value]) => `${key}=${truncateValue(value)}`)
    .join(", ");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function formatCompactFields(values: Array<string | null>): string {
  return values.filter((item): item is string => Boolean(item)).map((item) => compactText(item, 120)).join(" / ");
}

function formatKeyValueSuffix(values: Record<string, string | null>): string {
  const suffix = Object.entries(values)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return suffix ? ` ${suffix}` : "";
}

function formatLatLon(lat: unknown, lon: unknown): string | null {
  const normalizedLat = getFirstNonEmptyString([lat]);
  const normalizedLon = getFirstNonEmptyString([lon]);
  return normalizedLat && normalizedLon ? `${normalizedLat},${normalizedLon}` : null;
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...`;
}

function getFirstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function truncateValue(value: unknown): string {
  const text = typeof value === "string"
    ? value
    : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
