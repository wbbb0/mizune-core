import type { MediaSemanticKind, MarketFaceMetadata } from "#services/onebot/messageSegments.ts";
import type { OneBotMessageFileSummary } from "#services/onebot/types.ts";
import type { ChatFileKind } from "#types/chatContracts.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import type { MediaLocator, MediaKind } from "#services/workspace/mediaSources/types.ts";

export type MessageContentPart =
  | { kind: "text"; text: string }
  | { kind: "image"; source?: string | undefined; fileId?: string | undefined; sourceName?: string | null | undefined; mimeType?: string | null | undefined; mediaRef?: string | undefined; marketFace?: MarketFaceMetadata; mediaLocator?: MediaLocator }
  | { kind: "emoji"; source?: string | undefined; fileId?: string | undefined; sourceName?: string | null | undefined; mimeType?: string | null | undefined; mediaRef?: string | undefined; marketFace?: MarketFaceMetadata; mediaLocator?: MediaLocator }
  | { kind: "pending_media"; mediaRef: string; mediaKind: MediaKind; sourceName: string | null }
  | { kind: "file"; file: OneBotMessageFileSummary }
  | { kind: "embedded_message"; relation: "reply" | "forward" | "message"; messageId?: string | undefined; senderId?: string | undefined; senderName?: string | undefined; parts: MessageContentPart[]; truncated?: boolean | undefined }
  | { kind: "remote_file"; source: string; sourceName: string; mimeType: string; fileKind: "file" | "video" }
  | { kind: "asset_file"; fileId: string; fileKind: ChatFileKind; sourceName: string | null; mimeType: string | null; sizeBytes: number | null; mediaRef?: string | undefined }
  | { kind: "mention"; target: "self" | "all" | "user"; userId?: string | undefined }
  | { kind: "reply"; messageId: string }
  | { kind: "forward"; forwardId: string }
  | { kind: "audio"; source?: string | undefined; audioId?: string | undefined }
  | { kind: "special"; segmentType: string; summary: string };

export type MessageMediaContentPart = Extract<MessageContentPart, { kind: "image" | "emoji" }>;

/** Imported content only: remote download inputs cannot enter a persisted subtree. */
export type PersistedMessageContentPart =
  | Exclude<MessageContentPart, { kind: "remote_file" | "embedded_message" }>
  | (Omit<Extract<MessageContentPart, { kind: "embedded_message" }>, "parts"> & {
      parts: PersistedMessageContentPart[];
    });

export function mediaPartKindToSemanticKind(kind: MessageMediaContentPart["kind"]): MediaSemanticKind {
  return kind === "emoji" ? "emoji" : "image";
}

export function semanticKindToMediaPartKind(kind: MediaSemanticKind): MessageMediaContentPart["kind"] {
  return kind === "emoji" ? "emoji" : "image";
}

export function collectContentPartMediaIds(
  contentParts: readonly MessageContentPart[] | undefined,
  kind: MessageMediaContentPart["kind"]
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of walkMessageContentParts(contentParts)) {
    if (part.kind !== kind || !part.fileId || seen.has(part.fileId)) {
      continue;
    }
    seen.add(part.fileId);
    ids.push(part.fileId);
  }
  return ids;
}

export function collectContentPartAttachments(contentParts: readonly MessageContentPart[] | undefined): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];
  const seen = new Set<string>();
  for (const part of walkMessageContentParts(contentParts)) {
    if (part.kind === "asset_file" && !seen.has(part.fileId)) {
      seen.add(part.fileId);
      attachments.push({ fileId: part.fileId, kind: part.fileKind, source: "chat_message", sourceName: part.sourceName, mimeType: part.mimeType });
      continue;
    }
    if ((part.kind !== "image" && part.kind !== "emoji") || !part.fileId || seen.has(part.fileId)) {
      continue;
    }
    seen.add(part.fileId);
    attachments.push({
      fileId: part.fileId,
      kind: "image",
      source: "chat_message",
      sourceName: part.sourceName ?? null,
      mimeType: part.mimeType ?? null,
      semanticKind: part.kind
    });
  }
  return attachments;
}

/** Enumerate embedded assets without promoting embedded authors or message roles. */
export function* walkMessageContentParts(contentParts: readonly MessageContentPart[] | undefined): Generator<MessageContentPart> {
  const pending = [...(contentParts ?? [])].reverse();
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const part = pending.pop()!;
    if (visited.has(part)) continue;
    visited.add(part);
    yield part;
    if (part.kind === "embedded_message") {
      for (let index = part.parts.length - 1; index >= 0; index -= 1) pending.push(part.parts[index]!);
    }
  }
}

export function resolveUserMessageMediaKind(
  contentParts: readonly MessageContentPart[] | undefined
): "image" | "emoji" | "mixed" | null {
  let hasImage = false;
  let hasEmoji = false;
  for (const part of contentParts ?? []) {
    if (part.kind === "text" && part.text.trim()) {
      return null;
    }
    if (part.kind === "image") {
      hasImage = true;
      continue;
    }
    if (part.kind === "emoji") {
      hasEmoji = true;
      continue;
    }
    if (part.kind === "mention" || part.kind === "reply") {
      continue;
    }
    return null;
  }
  if (!hasImage && !hasEmoji) {
    return null;
  }
  if (hasImage && hasEmoji) {
    return "mixed";
  }
  return hasEmoji ? "emoji" : "image";
}

export function hasContentPartText(contentParts: readonly MessageContentPart[] | undefined): boolean {
  return (contentParts ?? []).some((part) => part.kind === "text" && part.text.trim().length > 0);
}
