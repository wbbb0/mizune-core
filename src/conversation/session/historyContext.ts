import type { MediaSemanticKind } from "#services/onebot/messageSegments.ts";
import type { OneBotMessageFileSummary, OneBotSpecialSegmentSummary } from "#services/onebot/types.ts";
import type { MessageContentPart } from "#messages/contentParts.ts";
import { resolveUserMessageMediaKind } from "#messages/contentParts.ts";
import type { UserStore } from "#identity/userStore.ts";
import {
  dedupeResolvedChatAttachments,
  getVisualAttachmentSemanticKind,
  isPendingChatAttachmentId
} from "#services/workspace/chatAttachments.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import type {
  InternalTranscriptItem,
  SessionHistoryMessage,
  TranscriptSessionModeSwitchItem,
  TranscriptAssistantMessageItem,
  TranscriptUserMediaMessageItem,
  TranscriptUserMessageItem,
  TranscriptItemDeliveryRef,
  TranscriptContentSafetyEvent,
  TranscriptItemSourceRef
} from "./sessionTypes.ts";

export function formatStructuredMediaReference(kind: MediaSemanticKind, imageId: string): string {
  return formatStructuredTag("ref", {
    kind,
    image_id: imageId
  });
}

export function formatStructuredImageReference(imageId: string): string {
  return formatStructuredMediaReference("image", imageId);
}

export function formatStructuredEmojiReference(imageId: string): string {
  return formatStructuredMediaReference("emoji", imageId);
}

export function formatStructuredForwardReference(forwardId: string): string {
  return formatStructuredTag("ref", {
    kind: "forward",
    forward_id: forwardId
  });
}

export function formatStructuredReplyReference(messageId: string): string {
  return formatStructuredTag("ref", {
    kind: "reply",
    message_id: messageId
  });
}

export function formatStructuredMentionReference(userId: string): string {
  return formatStructuredTag("mention", {
    target: "user",
    user_id: userId
  });
}

export function formatStructuredMentionSelfReference(): string {
  return formatStructuredTag("mention", { target: "self" });
}

export function formatStructuredMentionAllReference(): string {
  return formatStructuredTag("mention", { target: "all" });
}

export function formatStructuredSpecialSegment(segment: OneBotSpecialSegmentSummary): string {
  return formatStructuredTag("segment", {
    type: segment.type,
    summary: segment.summary
  });
}

export function formatStructuredAudioReference(audioId: string): string {
  return formatStructuredTag("audio", {
    audio_id: audioId
  });
}

export function formatStructuredMessageFile(file: OneBotMessageFileSummary): string {
  return formatStructuredTag("file", {
    file_id: file.fileId,
    ...(file.name ? { name: file.name } : {}),
    ...(file.busid != null ? { busid: String(file.busid) } : {}),
    ...(file.sizeBytes != null ? { size_bytes: String(file.sizeBytes) } : {}),
    ...(file.mimeType ? { mime_type: file.mimeType } : {}),
    download_tool: file.downloadTool
  });
}

export function formatStructuredAssetFile(file: {
  fileId: string;
  fileKind?: string | null;
  sourceName?: string | null;
  sizeBytes?: number | null;
  mimeType?: string | null;
}): string {
  return formatStructuredTag("asset_file", {
    file_id: file.fileId,
    ...(file.fileKind ? { file_kind: file.fileKind } : {}),
    ...(file.sourceName ? { name: file.sourceName } : {}),
    ...(file.sizeBytes != null ? { size_bytes: String(file.sizeBytes) } : {}),
    ...(file.mimeType ? { mime_type: file.mimeType } : {})
  });
}

export function formatStructuredCount(kind: string, value: number | string): string {
  return formatStructuredTag("count", { kind, value: String(value) });
}

export function formatSessionModeSwitchContent(input: {
  fromModeId: string;
  toModeId: string;
  timestampMs: number;
}): string {
  return formatStructuredTag("session_mode_switch", {
    from_mode: input.fromModeId,
    to_mode: input.toModeId,
    timestamp: new Date(input.timestampMs).toISOString()
  });
}

export function formatHistoryContent(input: {
  text: string;
  contentParts?: MessageContentPart[];
  imageIds?: string[];
  emojiIds?: string[];
  attachments?: ChatAttachment[];
  messageFiles?: OneBotMessageFileSummary[];
  specialSegments?: OneBotSpecialSegmentSummary[];
  audioCount?: number;
  forwardIds?: string[];
  replyMessageId?: string | null;
  mentionUserIds?: string[];
  mentionedAll?: boolean;
  mentionedSelf?: boolean;
}): string {
  if ((input.contentParts?.length ?? 0) > 0) {
    return formatMessageContentParts(input.contentParts ?? []);
  }

  const parts: string[] = [];
  if (input.replyMessageId) {
    parts.push(formatStructuredReplyReference(input.replyMessageId));
  }
  if (input.mentionedSelf) {
    parts.push(formatStructuredMentionSelfReference());
  }
  if (input.mentionedAll) {
    parts.push(formatStructuredMentionAllReference());
  }
  for (const userId of input.mentionUserIds ?? []) {
    parts.push(formatStructuredMentionReference(userId));
  }
  if (input.text.trim()) {
    parts.push(escapeStructuredText(input.text.trim()));
  }
  if ((input.audioCount ?? 0) > 0) {
    parts.push(formatStructuredCount("audio", input.audioCount ?? 0));
  }
  for (const mediaRef of collectStructuredMediaRefs(input)) {
    parts.push(formatStructuredMediaReference(mediaRef.kind, mediaRef.fileId));
  }
  for (const file of input.messageFiles ?? []) {
    parts.push(formatStructuredMessageFile(file));
  }
  for (const segment of input.specialSegments ?? []) {
    parts.push(formatStructuredSpecialSegment(segment));
  }
  for (const forwardId of input.forwardIds ?? []) {
    parts.push(formatStructuredForwardReference(forwardId));
  }
  return parts.join("\n") || "<empty>";
}

function collectStructuredMediaRefs(input: {
  imageIds?: string[];
  emojiIds?: string[];
  attachments?: ChatAttachment[];
}): Array<{ kind: MediaSemanticKind; fileId: string }> {
  const refs: Array<{ kind: MediaSemanticKind; fileId: string }> = [];
  const seen = new Set<string>();

  const add = (kind: MediaSemanticKind, rawFileId: string): void => {
    const fileId = String(rawFileId ?? "").trim();
    if (!fileId || isPendingChatAttachmentId(fileId) || seen.has(fileId)) {
      return;
    }
    seen.add(fileId);
    refs.push({ kind, fileId });
  };

  for (const emojiId of input.emojiIds ?? []) {
    add("emoji", emojiId);
  }
  for (const imageId of input.imageIds ?? []) {
    add("image", imageId);
  }
  for (const attachment of dedupeResolvedChatAttachments(input.attachments ?? [])) {
    const kind = getVisualAttachmentSemanticKind(attachment);
    if (kind) {
      add(kind, attachment.fileId);
    }
  }
  return refs;
}

export function formatUserHistoryEntry(input: {
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
  contentParts?: MessageContentPart[];
  imageIds?: string[];
  emojiIds?: string[];
  attachments?: ChatAttachment[];
  messageFiles?: OneBotMessageFileSummary[];
  specialSegments?: OneBotSpecialSegmentSummary[];
  audioCount?: number;
  forwardIds?: string[];
  replyMessageId?: string | null;
  mentionUserIds?: string[];
  mentionedAll?: boolean;
  mentionedSelf?: boolean;
}): string {
  const contentInput: Parameters<typeof formatHistoryContent>[0] = {
    text: input.text
  };
  if (input.contentParts) {
    contentInput.contentParts = input.contentParts;
  }
  if (input.imageIds) {
    contentInput.imageIds = input.imageIds;
  }
  if (input.emojiIds) {
    contentInput.emojiIds = input.emojiIds;
  }
  if (input.attachments) {
    contentInput.attachments = input.attachments;
  }
  if (input.messageFiles) {
    contentInput.messageFiles = input.messageFiles;
  }
  if (input.specialSegments) {
    contentInput.specialSegments = input.specialSegments;
  }
  if (input.audioCount) {
    contentInput.audioCount = input.audioCount;
  }
  if (input.forwardIds) {
    contentInput.forwardIds = input.forwardIds;
  }
  if (input.replyMessageId) {
    contentInput.replyMessageId = input.replyMessageId;
  }
  if (input.mentionUserIds) {
    contentInput.mentionUserIds = input.mentionUserIds;
  }
  if (input.mentionedAll) {
    contentInput.mentionedAll = input.mentionedAll;
  }
  if (input.mentionedSelf) {
    contentInput.mentionedSelf = input.mentionedSelf;
  }
  const content = formatHistoryContent(contentInput);
  if (input.chatType === "group") {
    return formatStructuredSpeakerReference("group_user", input.userId, input.senderName, content);
  }
  return content;
}

export function formatAssistantHistoryEntry(input: {
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
}): string {
  if (input.chatType === "group") {
    return formatStructuredSpeakerReference("assistant_to", input.userId, input.senderName, escapeStructuredText(input.text));
  }
  return escapeStructuredText(input.text);
}

export function createUserTranscriptMessageItem(input: {
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
  contentParts?: MessageContentPart[];
  imageIds?: string[];
  emojiIds?: string[];
  attachments?: ChatAttachment[];
  messageFiles?: OneBotMessageFileSummary[];
  specialSegments?: OneBotSpecialSegmentSummary[];
  audioCount?: number;
  forwardIds?: string[];
  replyMessageId?: string | null;
  mentionUserIds?: string[];
  mentionedAll?: boolean;
  mentionedSelf?: boolean;
  sourceRef?: TranscriptItemSourceRef;
  contentSafetyEvents?: TranscriptContentSafetyEvent[];
  runtimeVisibility?: TranscriptUserMessageItem["runtimeVisibility"];
  timestampMs: number;
}): TranscriptUserMessageItem | TranscriptUserMediaMessageItem {
  const mediaKind = resolveUserMessageMediaKind(input.contentParts);
  if (mediaKind) {
    return createUserMediaTranscriptMessageItem({
      ...input,
      contentParts: input.contentParts ?? [],
      mediaKind
    });
  }

  return {
    kind: "user_message",
    role: "user",
    llmVisible: true,
    chatType: input.chatType,
    userId: input.userId,
    senderName: input.senderName,
    text: input.text,
    contentParts: [...(input.contentParts ?? [])],
    imageIds: [...(input.imageIds ?? [])],
    emojiIds: [...(input.emojiIds ?? [])],
    attachments: [...(input.attachments ?? [])],
    messageFiles: [...(input.messageFiles ?? [])],
    ...(input.specialSegments && input.specialSegments.length > 0 ? { specialSegments: [...input.specialSegments] } : {}),
    audioCount: input.audioCount ?? 0,
    forwardIds: [...(input.forwardIds ?? [])],
    replyMessageId: input.replyMessageId ?? null,
    mentionUserIds: [...(input.mentionUserIds ?? [])],
    mentionedAll: input.mentionedAll === true,
    mentionedSelf: input.mentionedSelf === true,
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    ...(input.runtimeVisibility ? { runtimeVisibility: input.runtimeVisibility } : {}),
    ...(input.contentSafetyEvents && input.contentSafetyEvents.length > 0 ? { contentSafetyEvents: input.contentSafetyEvents } : {}),
    timestampMs: input.timestampMs
  };
}

function createUserMediaTranscriptMessageItem(input: {
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  mediaKind: "image" | "emoji" | "mixed";
  contentParts: MessageContentPart[];
  imageIds?: string[];
  emojiIds?: string[];
  attachments?: ChatAttachment[];
  replyMessageId?: string | null;
  mentionUserIds?: string[];
  mentionedAll?: boolean;
  mentionedSelf?: boolean;
  sourceRef?: TranscriptItemSourceRef;
  contentSafetyEvents?: TranscriptContentSafetyEvent[];
  runtimeVisibility?: TranscriptUserMessageItem["runtimeVisibility"];
  timestampMs: number;
}): TranscriptUserMediaMessageItem {
  return {
    kind: "user_media_message",
    role: "user",
    llmVisible: true,
    chatType: input.chatType,
    userId: input.userId,
    senderName: input.senderName,
    mediaKind: input.mediaKind,
    contentParts: [...input.contentParts],
    imageIds: [...(input.imageIds ?? [])],
    emojiIds: [...(input.emojiIds ?? [])],
    attachments: [...(input.attachments ?? [])],
    replyMessageId: input.replyMessageId ?? null,
    mentionUserIds: [...(input.mentionUserIds ?? [])],
    mentionedAll: input.mentionedAll === true,
    mentionedSelf: input.mentionedSelf === true,
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    ...(input.runtimeVisibility ? { runtimeVisibility: input.runtimeVisibility } : {}),
    ...(input.contentSafetyEvents && input.contentSafetyEvents.length > 0 ? { contentSafetyEvents: input.contentSafetyEvents } : {}),
    timestampMs: input.timestampMs
  };
}

export function createAssistantTranscriptMessageItem(input: {
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
  reasoningContent?: string;
  deliveryRef?: TranscriptItemDeliveryRef;
  timestampMs: number;
}): TranscriptAssistantMessageItem {
  return {
    kind: "assistant_message",
    role: "assistant",
    llmVisible: true,
    chatType: input.chatType,
    userId: input.userId,
    senderName: input.senderName,
    text: input.text,
    ...(input.reasoningContent ? { reasoningContent: input.reasoningContent } : {}),
    ...(input.deliveryRef ? { deliveryRef: input.deliveryRef } : {}),
    timestampMs: input.timestampMs
  };
}

export function createSessionModeSwitchTranscriptItem(input: {
  fromModeId: string;
  toModeId: string;
  timestampMs: number;
}): TranscriptSessionModeSwitchItem {
  return {
    kind: "session_mode_switch",
    role: "assistant",
    llmVisible: true,
    fromModeId: input.fromModeId,
    toModeId: input.toModeId,
    content: formatSessionModeSwitchContent(input),
    timestampMs: input.timestampMs
  };
}

export function projectTranscriptMessageItemToHistoryMessage(
  item: TranscriptUserMessageItem | TranscriptUserMediaMessageItem | TranscriptAssistantMessageItem | TranscriptSessionModeSwitchItem
): SessionHistoryMessage {
  if (item.kind === "session_mode_switch") {
    return {
      role: item.role,
      content: item.content,
      timestampMs: item.timestampMs
    };
  }
  if (item.kind === "assistant_message") {
    return {
      role: item.role,
      content: formatAssistantHistoryEntry({
        chatType: item.chatType,
        userId: item.userId,
        senderName: item.senderName,
        text: item.text
      }),
      timestampMs: item.timestampMs
    };
  }
  const contentParts = item.contentParts ?? [];
  return {
    role: item.role,
    content: formatUserHistoryEntry({
          chatType: item.chatType,
          userId: item.userId,
          senderName: item.senderName,
          text: item.kind === "user_message" ? item.text : "",
          ...(contentParts.length > 0 ? { contentParts } : {}),
          ...(item.imageIds.length > 0 ? { imageIds: item.imageIds } : {}),
          ...(item.emojiIds.length > 0 ? { emojiIds: item.emojiIds } : {}),
          ...(item.attachments && item.attachments.length > 0 ? { attachments: item.attachments } : {}),
          ...(item.kind === "user_message" && item.messageFiles && item.messageFiles.length > 0 ? { messageFiles: item.messageFiles } : {}),
          ...(item.kind === "user_message" && item.specialSegments && item.specialSegments.length > 0 ? { specialSegments: item.specialSegments } : {}),
          ...(item.kind === "user_message" && item.audioCount > 0 ? { audioCount: item.audioCount } : {}),
          ...(item.kind === "user_message" && item.forwardIds.length > 0 ? { forwardIds: item.forwardIds } : {}),
          ...(item.replyMessageId ? { replyMessageId: item.replyMessageId } : {}),
          ...(item.mentionUserIds.length > 0 ? { mentionUserIds: item.mentionUserIds } : {}),
          ...(item.mentionedAll ? { mentionedAll: true } : {}),
          ...(item.mentionedSelf ? { mentionedSelf: true } : {})
        }),
    timestampMs: item.timestampMs
  };
}

export async function extractWindowUsers(
  userStore: UserStore,
  recentMessages: InternalTranscriptItem[],
  batchMessages: Array<{ userId: string; senderName: string }>
): Promise<Array<{
  userId: string;
  displayName: string;
  relationshipLabel: string;
  preferredAddress?: string;
  gender?: string;
  residence?: string;
  timezone?: string;
  occupation?: string;
  profileSummary?: string;
  relationshipNote?: string;
}>> {
  const participants = new Map<string, string>();
  for (const message of batchMessages) {
    participants.set(message.userId, message.senderName);
  }

  for (const message of recentMessages) {
    if (message.runtimeExcluded === true) {
      continue;
    }
    if (message.kind === "user_message" || message.kind === "user_media_message" || message.kind === "assistant_message") {
      participants.set(message.userId, message.senderName || message.userId);
    }
  }

  return Promise.all(
    Array.from(participants.entries()).map(async ([userId, displayName]) => {
      const user = await userStore.getByUserId(userId);
      const relationshipLabel = user?.relationship === "owner"
        ? "主人"
        : user?.relationship === "known"
          ? "熟人"
          : "未建档";
      return {
        userId,
        displayName: user?.preferredAddress ?? displayName,
        relationshipLabel,
        ...(user?.preferredAddress ? { preferredAddress: user.preferredAddress } : {}),
        ...(user?.gender ? { gender: user.gender } : {}),
        ...(user?.residence ? { residence: user.residence } : {}),
        ...(user?.timezone ? { timezone: user.timezone } : {}),
        ...(user?.occupation ? { occupation: user.occupation } : {}),
        ...(user?.profileSummary ? { profileSummary: user.profileSummary } : {}),
        ...(user?.relationshipNote ? { relationshipNote: user.relationshipNote } : {})
      };
    })
  );
}

function formatStructuredSpeakerReference(
  role: "group_user" | "assistant_to",
  userId: string,
  senderName: string,
  content: string
): string {
  return `${formatStructuredTag("speaker", {
    role,
    user_id: userId,
    name: senderName
  })}\n${content}`;
}

function formatMessageContentParts(contentParts: readonly MessageContentPart[]): string {
  const parts: string[] = [];
  for (const part of contentParts) {
    switch (part.kind) {
      case "text":
        if (part.text.trim()) {
          parts.push(escapeStructuredText(part.text.trim()));
        }
        break;
      case "image":
      case "emoji":
        if (part.fileId) {
          parts.push(formatStructuredMediaReference(part.kind, part.fileId));
        }
        break;
      case "file":
        parts.push(formatStructuredMessageFile(part.file));
        break;
      case "asset_file":
        parts.push(formatStructuredAssetFile(part));
        break;
      case "mention":
        if (part.target === "self") {
          parts.push(formatStructuredMentionSelfReference());
        } else if (part.target === "all") {
          parts.push(formatStructuredMentionAllReference());
        } else if (part.userId) {
          parts.push(formatStructuredMentionReference(part.userId));
        }
        break;
      case "reply":
        parts.push(formatStructuredReplyReference(part.messageId));
        break;
      case "forward":
        parts.push(formatStructuredForwardReference(part.forwardId));
        break;
      case "audio":
        parts.push(part.audioId ? formatStructuredAudioReference(part.audioId) : formatStructuredCount("audio", 1));
        break;
      case "special":
        parts.push(formatStructuredSpecialSegment({
          type: part.segmentType,
          summary: part.summary
        }));
        break;
    }
  }
  return parts.join("\n") || "<empty>";
}

function formatStructuredTag(name: string, attrs: Record<string, string>): string {
  const rendered = Object.entries(attrs)
    .map(([key, value]) => `${key}="${escapeStructuredAttribute(value)}"`)
    .join(" ");
  return `⟦${name}${rendered ? ` ${rendered}` : ""}⟧`;
}

function escapeStructuredAttribute(value: string): string {
  return String(value)
    .replace(/"/g, "＂")
    .replace(/⟦/g, "［")
    .replace(/⟧/g, "］")
    .replace(/\r?\n/g, " ");
}

function escapeStructuredText(value: string): string {
  return String(value)
    .replace(/⟦/g, "[")
    .replace(/⟧/g, "]");
}
