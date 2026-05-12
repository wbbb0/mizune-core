import type {
  InternalTranscriptItem,
  InternalToolResultItem,
  PersistedSessionMessage,
  PersistedSessionState,
  SessionMessage,
  SessionState,
  TranscriptMessageContentPart,
  TranscriptUserMediaMessageItem,
  TranscriptUserMessageItem
} from "#conversation/session/sessionTypes.ts";
import { isPendingChatAttachmentId } from "#services/workspace/chatAttachments.ts";
import type { AssetSessionRef } from "./assetLifecycleStore.ts";

export function collectSessionAssetRefs(
  sessions: Array<SessionState | PersistedSessionState>,
  now: number
): AssetSessionRef[] {
  const refs = new Map<string, AssetSessionRef>();
  for (const session of sessions) {
    const sessionId = session.id;
    const add = (assetKind: AssetSessionRef["assetKind"], assetId: string, refKind: string) => {
      if (!assetId || isPendingChatAttachmentId(assetId)) return;
      const key = `${assetKind}:${assetId}:${sessionId}:${refKind}`;
      refs.set(key, {
        assetKind,
        assetId,
        sessionId,
        refKind,
        createdAtMs: now,
        lastSeenAtMs: now,
        expiresAtMs: null
      });
    };
    for (const message of session.pendingMessages) {
      collectFromMessage(add, message);
    }
    for (const item of session.internalTranscript) {
      collectFromTranscriptItem(add, item);
    }
  }
  return Array.from(refs.values());
}

function collectFromMessage(
  add: (assetKind: AssetSessionRef["assetKind"], assetId: string, refKind: string) => void,
  message: PersistedSessionMessage | SessionMessage
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

function collectFromTranscriptItem(
  add: (assetKind: AssetSessionRef["assetKind"], assetId: string, refKind: string) => void,
  item: InternalTranscriptItem
): void {
  if (item.kind === "user_message") {
    collectFromTranscriptUserMessage(add, item);
    return;
  }
  if (item.kind === "user_media_message") {
    collectFromTranscriptUserMediaMessage(add, item);
    return;
  }
  if (item.kind === "outbound_media_message" && item.fileId) {
    add("chat_file", item.fileId, "transcript");
    return;
  }
  if (item.kind === "tool_result") {
    collectFromToolResult(add, item);
  }
}

function collectFromTranscriptUserMessage(
  add: (assetKind: AssetSessionRef["assetKind"], assetId: string, refKind: string) => void,
  item: TranscriptUserMessageItem
): void {
  for (const fileId of [...item.imageIds, ...item.emojiIds]) {
    add("chat_file", fileId, "transcript");
  }
  for (const attachment of item.attachments ?? []) {
    add("chat_file", attachment.fileId, "transcript");
  }
  collectFromContentParts(add, item.contentParts);
}

function collectFromTranscriptUserMediaMessage(
  add: (assetKind: AssetSessionRef["assetKind"], assetId: string, refKind: string) => void,
  item: TranscriptUserMediaMessageItem
): void {
  for (const fileId of [...item.imageIds, ...item.emojiIds]) {
    add("chat_file", fileId, "transcript");
  }
  for (const attachment of item.attachments ?? []) {
    add("chat_file", attachment.fileId, "transcript");
  }
  collectFromContentParts(add, item.contentParts);
}

function collectFromContentParts(
  add: (assetKind: AssetSessionRef["assetKind"], assetId: string, refKind: string) => void,
  contentParts: readonly TranscriptMessageContentPart[] | undefined
): void {
  for (const part of contentParts ?? []) {
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
  add: (assetKind: AssetSessionRef["assetKind"], assetId: string, refKind: string) => void,
  item: InternalToolResultItem
): void {
  if (item.observation?.resource?.kind === "asset") {
    add("chat_file", item.observation.resource.id, "tool_result");
  }
  collectAssetIdsFromJsonText(add, item.content);
  collectAssetIdsFromJsonText(add, item.observation?.replayContent);
}

function collectAssetIdsFromJsonText(
  add: (assetKind: AssetSessionRef["assetKind"], assetId: string, refKind: string) => void,
  text: string | undefined
): void {
  if (!text) return;
  const parsed = parseJsonObject(text);
  if (!parsed) return;
  collectAssetIdsFromValue(add, parsed);
}

function collectAssetIdsFromValue(
  add: (assetKind: AssetSessionRef["assetKind"], assetId: string, refKind: string) => void,
  value: unknown
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAssetIdsFromValue(add, item);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["fileId", "file_id", "fileRef", "file_ref", "assetId", "asset_id", "assetRef", "asset_ref"]) {
    const id = typeof record[key] === "string" ? record[key] : null;
    if (id) {
      add("chat_file", id, "tool_result");
    }
  }
  for (const item of Object.values(record)) {
    collectAssetIdsFromValue(add, item);
  }
}

function parseJsonObject(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
