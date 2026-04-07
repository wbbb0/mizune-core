import type { OneBotMessageSegment } from "./types.ts";

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
  const data = segment.data && typeof segment.data === "object"
    ? Object.entries(segment.data)
      .slice(0, 3)
      .map(([key, value]) => `${key}=${truncateValue(value)}`)
      .join(", ")
    : "";

  return data ? `${segment.type}(${data})` : segment.type;
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
