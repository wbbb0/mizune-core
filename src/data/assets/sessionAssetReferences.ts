import { walkMessageContentParts } from "#messages/contentParts.ts";
import { isImmutableTranscriptItem } from "#conversation/session/immutableTranscript.ts";
import type {
  InternalTranscriptItem,
  InternalToolResultItem,
  PersistedSessionState,
  SessionState,
  TranscriptMessageContentPart
} from "#conversation/session/sessionTypes.ts";
import { isPendingChatAttachmentId } from "#services/workspace/chatAttachments.ts";
import type { AssetSessionRef } from "./assetLifecycleStore.ts";

export type AssetReference = Pick<AssetSessionRef, "assetKind" | "assetId">;
type CollectedAssetReference = AssetReference & { refKind: string };
type AddReference = (assetKind: AssetReference["assetKind"], assetId: string, refKind: string) => void;
interface SessionAssetMessage {
  imageIds: readonly string[];
  emojiIds: readonly string[];
  audioIds?: readonly string[] | undefined;
  attachments?: readonly { fileId: string }[] | undefined;
  contentParts?: readonly TranscriptMessageContentPart[] | undefined;
}

interface SessionAssetSource {
  pendingMessages: readonly SessionAssetMessage[];
  pendingSteerMessages?: readonly SessionAssetMessage[] | undefined;
  queuedGroupReplyTargets?: readonly { messages: readonly SessionAssetMessage[] }[] | undefined;
  internalTranscript: readonly InternalTranscriptItem[];
}

const immutableTranscriptReferences = new WeakMap<InternalTranscriptItem, readonly CollectedAssetReference[]>();
const chatFileReferenceFields = new Set(["fileId", "file_id", "fileRef", "file_ref", "assetId", "asset_id", "assetRef", "asset_ref"]);

/** Typed asset fields are the single source for GC, durable ownership, and admin media projections. */
export function collectSessionAssetReferences(session: SessionAssetSource): CollectedAssetReference[] {
  return collectReferences((add) => {
    for (const message of session.pendingMessages) collectFromMessage(add, message);
    for (const message of session.pendingSteerMessages ?? []) collectFromMessage(add, message);
    for (const target of session.queuedGroupReplyTargets ?? []) {
      for (const message of target.messages) collectFromMessage(add, message);
    }
    for (const item of session.internalTranscript) addTranscriptReferences(add, item);
  });
}

export function collectTranscriptAssetReferences(transcript: readonly InternalTranscriptItem[]): CollectedAssetReference[] {
  return collectReferences((add) => {
    for (const item of transcript) addTranscriptReferences(add, item);
  });
}

export function collectTranscriptMediaIds(transcript: readonly InternalTranscriptItem[]): { chatFileIds: string[]; audioIds: string[] } {
  const references = collectTranscriptAssetReferences(transcript);
  return {
    chatFileIds: [...new Set(references.filter(ref => ref.assetKind === "chat_file").map(ref => ref.assetId))],
    audioIds: [...new Set(references.filter(ref => ref.assetKind === "audio").map(ref => ref.assetId))]
  };
}

function collectReferences(visit: (add: AddReference) => void): CollectedAssetReference[] {
  const references = new Map<string, CollectedAssetReference>();
  visit((assetKind, rawAssetId, refKind) => {
    const assetId = rawAssetId.trim();
    if (!assetId || isPendingChatAttachmentId(assetId)) return;
    references.set(JSON.stringify([assetKind, assetId, refKind]), { assetKind, assetId, refKind });
  });
  return [...references.values()];
}

export function collectSessionAssetRefs(
  sessions: Array<SessionState | PersistedSessionState>,
  now: number
): AssetSessionRef[] {
  return sessions.flatMap(session => collectSessionAssetReferences(session).map(reference => ({
    ...reference, sessionId: session.id, createdAtMs: now, lastSeenAtMs: now, expiresAtMs: null
  })));
}

function collectFromMessage(
  add: AddReference,
  message: SessionAssetMessage
): void {
  for (const fileId of [...message.imageIds, ...message.emojiIds]) {
    add("chat_file", fileId, "message");
  }
  for (const audioId of message.audioIds ?? []) {
    add("audio", audioId, "message");
  }
  for (const attachment of message.attachments ?? []) {
    add("chat_file", attachment.fileId, "message");
  }
  collectFromContentParts(add, message.contentParts);
}

function addTranscriptReferences(add: AddReference, item: InternalTranscriptItem): void {
  const immutable = isImmutableTranscriptItem(item);
  let references = immutable ? immutableTranscriptReferences.get(item) : undefined;
  if (!references) {
    references = collectReferences((collect) => collectFromTranscriptItem(collect, item));
    if (immutable) immutableTranscriptReferences.set(item, references);
  }
  for (const reference of references) add(reference.assetKind, reference.assetId, reference.refKind);
}

function collectFromTranscriptItem(
  add: AddReference,
  item: InternalTranscriptItem
): void {
  if (item.kind === "user_message" || item.kind === "user_media_message") {
    for (const fileId of [...item.imageIds, ...item.emojiIds]) add("chat_file", fileId, "transcript");
    for (const attachment of item.attachments ?? []) add("chat_file", attachment.fileId, "transcript");
    collectFromContentParts(add, item.contentParts);
    return;
  }
  if (item.kind === "outbound_media_message") {
    if (item.fileId) add("chat_file", item.fileId, "transcript");
    if (item.fileRef) add("chat_file", item.fileRef, "transcript");
    return;
  }
  if (item.kind === "tool_result") {
    collectFromToolResult(add, item);
  }
}

function collectFromContentParts(
  add: AddReference,
  contentParts: readonly TranscriptMessageContentPart[] | undefined
): void {
  for (const part of walkMessageContentParts(contentParts)) {
    if ((part.kind === "image" || part.kind === "emoji" || part.kind === "asset_file") && part.fileId) {
      add("chat_file", part.fileId, "content_part");
      continue;
    }
    if (part.kind === "file" && part.file.fileId) {
      add("chat_file", part.file.fileId, "content_part");
      continue;
    }
    if (part.kind === "audio" && part.audioId) {
      add("audio", part.audioId, "content_part");
    }
  }
}

function collectFromToolResult(
  add: AddReference,
  item: InternalToolResultItem
): void {
  if (item.observation?.resource?.kind === "asset") {
    add("chat_file", item.observation.resource.id, "tool_result");
  }
  collectAssetIdsFromJsonText(add, item.content);
  collectAssetIdsFromJsonText(add, item.observation?.replayContent);
}

function collectAssetIdsFromJsonText(
  add: AddReference,
  text: string | undefined
): void {
  if (!text) return;
  const parsed = parseJsonObject(text);
  if (!parsed) return;
  collectAssetIdsFromValue(add, parsed);
}

function collectAssetIdsFromValue(
  add: AddReference,
  value: unknown
): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    for (const [field, child] of Object.entries(current)) {
      if (typeof child === "string") {
        if (chatFileReferenceFields.has(field)) add("chat_file", child, "tool_result");
        else if (field === "audioId" || field === "audio_id") add("audio", child, "tool_result");
      } else if (child && typeof child === "object") {
        pending.push(child);
      }
    }
  }
}

function parseJsonObject(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
