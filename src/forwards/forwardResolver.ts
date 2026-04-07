import type { Logger } from "pino";
import type { OneBotClient } from "#services/onebot/onebotClient.ts";
import type { OneBotMessageSegment } from "#services/onebot/types.ts";
import { getSegmentMediaKind, type MediaSemanticKind } from "#services/onebot/messageSegments.ts";

export interface ForwardSegmentText {
  kind: "text";
  text: string;
}

export interface ForwardSegmentImage {
  kind: "image";
  imageId: string;
  url: string;
  viewable: boolean;
  mediaKind: MediaSemanticKind;
}

export interface ForwardSegmentNestedForward {
  kind: "forward";
  forwardId: string;
}

export interface ForwardSegmentOther {
  kind: "other";
  type: string;
  summary: string;
}

export type ForwardNodeSegment =
  | ForwardSegmentText
  | ForwardSegmentImage
  | ForwardSegmentNestedForward
  | ForwardSegmentOther;

export interface ResolvedForwardNode {
  nodeIndex: number;
  senderName: string;
  userId: string | null;
  time: number | null;
  segments: ForwardNodeSegment[];
  preview: string;
}

export interface ResolvedForwardRecord {
  forwardId: string;
  fetchedAt: number;
  nodes: ResolvedForwardNode[];
}

export interface ResolvedForwardImage {
  imageId: string;
  forwardId: string;
  nodeIndex: number;
  imageIndex: number;
  url: string;
  viewable: boolean;
  mediaKind: MediaSemanticKind;
}

interface ParsedForwardImageId {
  forwardId: string;
  nodeIndex: number;
  imageIndex: number;
}

export class ForwardResolver {
  private readonly recordCache = new Map<string, Promise<ResolvedForwardRecord>>();

  constructor(
    private readonly oneBotClient: OneBotClient,
    private readonly logger: Logger
  ) {}

  async resolveForwardRecord(forwardId: string): Promise<ResolvedForwardRecord> {
    const normalizedForwardId = String(forwardId).trim();
    if (!normalizedForwardId) {
      throw new Error("forwardId is required");
    }

    const cached = this.recordCache.get(normalizedForwardId);
    if (cached) {
      return cached;
    }

    const task = this.fetchForwardRecord(normalizedForwardId).catch((error) => {
      this.recordCache.delete(normalizedForwardId);
      throw error;
    });
    this.recordCache.set(normalizedForwardId, task);
    return task;
  }

  async resolveImages(imageIds: string[]): Promise<ResolvedForwardImage[]> {
    const parsed = imageIds.map((imageId) => ({
      imageId,
      parsed: parseForwardImageId(imageId)
    }));
    const forwardIds = Array.from(new Set(parsed.map((item) => item.parsed.forwardId)));
    const records = new Map<string, ResolvedForwardRecord>();

    await Promise.all(forwardIds.map(async (forwardId) => {
      records.set(forwardId, await this.resolveForwardRecord(forwardId));
    }));

    return parsed.map(({ imageId, parsed: target }) => {
      const record = records.get(target.forwardId);
      if (!record) {
        throw new Error(`Forward record not found for image id: ${imageId}`);
      }
      const node = record.nodes[target.nodeIndex];
      if (!node) {
        throw new Error(`Forward node not found for image id: ${imageId}`);
      }
      const images = node.segments.filter((segment): segment is ForwardSegmentImage => segment.kind === "image");
      const image = images[target.imageIndex];
      if (!image) {
        throw new Error(`Forward image not found for image id: ${imageId}`);
      }

      return {
        imageId,
        forwardId: target.forwardId,
        nodeIndex: target.nodeIndex,
        imageIndex: target.imageIndex,
        url: image.url,
        viewable: image.viewable,
        mediaKind: image.mediaKind
      };
    });
  }

  private async fetchForwardRecord(forwardId: string): Promise<ResolvedForwardRecord> {
    const entries = await this.oneBotClient.getForwardMessage(forwardId);
    const nodes = entries
      .map((entry, nodeIndex) => normalizeForwardEntry(forwardId, entry, nodeIndex))
      .filter((item): item is ResolvedForwardNode => item != null);

    if (nodes.length === 0) {
      this.logger.warn({
        forwardId,
        segmentCount: entries.length,
        entryKinds: entries.map((entry) => summarizeForwardEntryKind(entry))
      }, "forward_record_empty_after_normalize");
    }

    return {
      forwardId,
      fetchedAt: Date.now(),
      nodes
    };
  }
}

function normalizeForwardEntry(
  forwardId: string,
  entry: unknown,
  nodeIndex: number
): ResolvedForwardNode | null {
  if (isNodeSegment(entry)) {
    return normalizeNodeSegment(forwardId, entry, nodeIndex);
  }
  if (isMessageObject(entry)) {
    return normalizeMessageObject(forwardId, entry, nodeIndex);
  }
  return null;
}

function normalizeNodeSegment(
  forwardId: string,
  segment: OneBotMessageSegment,
  nodeIndex: number
): ResolvedForwardNode | null {
  if (segment.type !== "node") {
    return null;
  }

  const data = segment.data ?? {};
  const senderName = getFirstNonEmptyString([
    data.name,
    data.nickname,
    typeof data.sender === "object" && data.sender ? (data.sender as Record<string, unknown>).nickname : undefined,
    typeof data.sender === "object" && data.sender ? (data.sender as Record<string, unknown>).card : undefined
  ]) || `node_${nodeIndex + 1}`;
  const userId = getFirstNonEmptyString([
    data.uin,
    data.user_id,
    typeof data.sender === "object" && data.sender ? (data.sender as Record<string, unknown>).user_id : undefined
  ]) || null;
  const time = getFiniteNumber(data.time);
  const content = Array.isArray(data.content)
    ? data.content as OneBotMessageSegment[]
    : [];
  let imageIndex = 0;

  const segments = content.flatMap((contentSegment) => normalizeContentSegment(
    forwardId,
    nodeIndex,
    contentSegment,
    () => {
      const current = imageIndex;
      imageIndex += 1;
      return current;
    }
  ));

  return {
    nodeIndex,
    senderName,
    userId,
    time,
    segments,
    preview: buildNodePreview(segments)
  };
}

function normalizeMessageObject(
  forwardId: string,
  entry: {
    sender?: Record<string, unknown>;
    user_id?: unknown;
    time?: unknown;
    message?: unknown;
  },
  nodeIndex: number
): ResolvedForwardNode | null {
  const sender = entry.sender && typeof entry.sender === "object"
    ? entry.sender
    : {};
  const senderName = getFirstNonEmptyString([
    sender.card,
    sender.nickname,
    entry.user_id
  ]) || `node_${nodeIndex + 1}`;
  const userId = getFirstNonEmptyString([
    entry.user_id,
    sender.user_id
  ]) || null;
  const time = getFiniteNumber(entry.time);
  const content = Array.isArray(entry.message)
    ? entry.message as OneBotMessageSegment[]
    : [];
  let imageIndex = 0;

  const segments = content.flatMap((contentSegment) => normalizeContentSegment(
    forwardId,
    nodeIndex,
    contentSegment,
    () => {
      const current = imageIndex;
      imageIndex += 1;
      return current;
    }
  ));

  return {
    nodeIndex,
    senderName,
    userId,
    time,
    segments,
    preview: buildNodePreview(segments)
  };
}

function normalizeContentSegment(
  forwardId: string,
  nodeIndex: number,
  segment: OneBotMessageSegment,
  nextImageIndex: () => number
): ForwardNodeSegment[] {
  if (segment.type === "text") {
    const text = String(segment.data.text ?? "");
    return text ? [{ kind: "text", text }] : [];
  }

  if (segment.type === "image" || segment.type === "mface") {
    const imageIndex = nextImageIndex();
    const source = getFirstNonEmptyString([
      segment.data.url,
      segment.data.file,
      segment.data.path,
      segment.data.src
    ]) || "";
    return [{
      kind: "image",
      imageId: buildForwardImageId(forwardId, nodeIndex, imageIndex),
      url: source,
      viewable: /^https?:\/\//i.test(source),
      mediaKind: getSegmentMediaKind(segment)
    }];
  }

  if (segment.type === "forward") {
    const nestedForwardId = getFirstNonEmptyString([
      segment.data.id,
      segment.data.resid,
      segment.data.forward_id,
      segment.data.message_id
    ]);
    return nestedForwardId
      ? [{ kind: "forward", forwardId: nestedForwardId }]
      : [{ kind: "other", type: "forward", summary: "[forward: unavailable]" }];
  }

  if (segment.type === "at") {
    const userId = String(segment.data.qq ?? "").trim();
    return userId ? [{ kind: "text", text: `@${userId}` }] : [];
  }

  return [{
    kind: "other",
    type: segment.type,
    summary: summarizeOtherSegment(segment)
  }];
}

function buildNodePreview(segments: ForwardNodeSegment[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") {
      parts.push(segment.text);
      continue;
    }
    if (segment.kind === "image") {
      parts.push(`\n⟦ref kind="${segment.mediaKind}" image_id="${segment.imageId}"⟧`);
      continue;
    }
    if (segment.kind === "forward") {
      parts.push(`\n⟦ref kind="forward" forward_id="${segment.forwardId}"⟧`);
      continue;
    }
    parts.push(`\n${segment.summary}`);
  }
  return parts.join("").trim() || "<empty>";
}

function summarizeOtherSegment(segment: OneBotMessageSegment): string {
  if (segment.type === "face") {
    return '⟦segment type="face"⟧';
  }
  if (segment.type === "reply") {
    return '⟦segment type="reply"⟧';
  }
  if (segment.type === "json") {
    return '⟦segment type="json"⟧';
  }
  if (segment.type === "xml") {
    return '⟦segment type="xml"⟧';
  }
  return `⟦segment type="${segment.type}"⟧`;
}

function getFirstNonEmptyString(values: unknown[]): string {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function getFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isNodeSegment(value: unknown): value is OneBotMessageSegment {
  return Boolean(
    value
    && typeof value === "object"
    && "type" in value
    && "data" in value
    && typeof (value as { type?: unknown }).type === "string"
  );
}

function isMessageObject(value: unknown): value is {
  sender?: Record<string, unknown>;
  user_id?: unknown;
  time?: unknown;
  message?: unknown;
} {
  return Boolean(
    value
    && typeof value === "object"
    && "message" in value
    && Array.isArray((value as { message?: unknown }).message)
  );
}

function summarizeForwardEntryKind(value: unknown): string {
  if (isNodeSegment(value)) {
    return `segment:${value.type}`;
  }
  if (isMessageObject(value)) {
    const messageType = typeof (value as { message_type?: unknown }).message_type === "string"
      ? String((value as { message_type?: unknown }).message_type)
      : "unknown";
    return `message_object:${messageType}`;
  }
  return typeof value;
}

function buildForwardImageId(forwardId: string, nodeIndex: number, imageIndex: number): string {
  const encodedForwardId = Buffer.from(forwardId, "utf8").toString("base64url");
  return `forward_image:${encodedForwardId}:${nodeIndex}:${imageIndex}`;
}

function parseForwardImageId(imageId: string): ParsedForwardImageId {
  const match = String(imageId).trim().match(/^forward_image:([^:]+):(\d+):(\d+)$/);
  if (!match) {
    throw new Error(`Invalid forward image id: ${imageId}`);
  }

  const encodedForwardId = String(match[1] ?? "").trim();
  const forwardId = Buffer.from(encodedForwardId, "base64url").toString("utf8").trim();
  const nodeIndex = Number(match[2]);
  const imageIndex = Number(match[3]);
  if (!forwardId || !Number.isInteger(nodeIndex) || nodeIndex < 0 || !Number.isInteger(imageIndex) || imageIndex < 0) {
    throw new Error(`Invalid forward image id: ${imageId}`);
  }

  return {
    forwardId,
    nodeIndex,
    imageIndex
  };
}
