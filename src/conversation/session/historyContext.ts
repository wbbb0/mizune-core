import type { MediaSemanticKind } from "#services/onebot/messageSegments.ts";
import type { UserStore } from "#identity/userStore.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import type {
  InternalTranscriptItem,
  SessionHistoryMessage,
  TranscriptAssistantMessageItem,
  TranscriptUserMessageItem
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

export function formatStructuredCount(kind: string, value: number | string): string {
  return formatStructuredTag("count", { kind, value: String(value) });
}

export function formatHistoryContent(input: {
  text: string;
  imageIds?: string[];
  emojiIds?: string[];
  attachments?: ChatAttachment[];
  audioCount?: number;
  forwardIds?: string[];
  replyMessageId?: string | null;
  mentionUserIds?: string[];
  mentionedAll?: boolean;
  mentionedSelf?: boolean;
}): string {
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
  for (const emojiId of input.emojiIds ?? []) {
    parts.push(formatStructuredEmojiReference(emojiId));
  }
  for (const imageId of input.imageIds ?? []) {
    parts.push(formatStructuredImageReference(imageId));
  }
  for (const attachment of input.attachments ?? []) {
    if (attachment.semanticKind === "emoji") {
      parts.push(formatStructuredEmojiReference(attachment.fileId));
      continue;
    }
    if (attachment.kind === "image" || attachment.kind === "animated_image") {
      parts.push(formatStructuredImageReference(attachment.fileId));
    }
  }
  for (const forwardId of input.forwardIds ?? []) {
    parts.push(formatStructuredForwardReference(forwardId));
  }
  return parts.join("\n") || "<empty>";
}

export function formatUserHistoryEntry(input: {
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
  imageIds?: string[];
  emojiIds?: string[];
  attachments?: ChatAttachment[];
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
  if (input.imageIds) {
    contentInput.imageIds = input.imageIds;
  }
  if (input.emojiIds) {
    contentInput.emojiIds = input.emojiIds;
  }
  if (input.attachments) {
    contentInput.attachments = input.attachments;
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
  imageIds?: string[];
  emojiIds?: string[];
  attachments?: ChatAttachment[];
  audioCount?: number;
  forwardIds?: string[];
  replyMessageId?: string | null;
  mentionUserIds?: string[];
  mentionedAll?: boolean;
  mentionedSelf?: boolean;
  timestampMs: number;
}): TranscriptUserMessageItem {
  return {
    kind: "user_message",
    role: "user",
    llmVisible: true,
    chatType: input.chatType,
    userId: input.userId,
    senderName: input.senderName,
    text: input.text,
    imageIds: [...(input.imageIds ?? [])],
    emojiIds: [...(input.emojiIds ?? [])],
    attachments: [...(input.attachments ?? [])],
    audioCount: input.audioCount ?? 0,
    forwardIds: [...(input.forwardIds ?? [])],
    replyMessageId: input.replyMessageId ?? null,
    mentionUserIds: [...(input.mentionUserIds ?? [])],
    mentionedAll: input.mentionedAll === true,
    mentionedSelf: input.mentionedSelf === true,
    timestampMs: input.timestampMs
  };
}

export function createAssistantTranscriptMessageItem(input: {
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
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
    timestampMs: input.timestampMs
  };
}

export function projectTranscriptMessageItemToHistoryMessage(
  item: TranscriptUserMessageItem | TranscriptAssistantMessageItem
): SessionHistoryMessage {
  return {
    role: item.role,
    content: item.kind === "user_message"
      ? formatUserHistoryEntry({
          chatType: item.chatType,
          userId: item.userId,
          senderName: item.senderName,
          text: item.text,
          ...(item.imageIds.length > 0 ? { imageIds: item.imageIds } : {}),
          ...(item.emojiIds.length > 0 ? { emojiIds: item.emojiIds } : {}),
          ...(item.attachments && item.attachments.length > 0 ? { attachments: item.attachments } : {}),
          ...(item.audioCount > 0 ? { audioCount: item.audioCount } : {}),
          ...(item.forwardIds.length > 0 ? { forwardIds: item.forwardIds } : {}),
          ...(item.replyMessageId ? { replyMessageId: item.replyMessageId } : {}),
          ...(item.mentionUserIds.length > 0 ? { mentionUserIds: item.mentionUserIds } : {}),
          ...(item.mentionedAll ? { mentionedAll: true } : {}),
          ...(item.mentionedSelf ? { mentionedSelf: true } : {})
        })
      : formatAssistantHistoryEntry({
          chatType: item.chatType,
          userId: item.userId,
          senderName: item.senderName,
          text: item.text
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
  profileSummary?: string;
  sharedContext?: string;
}>> {
  const participants = new Map<string, string>();
  for (const message of batchMessages) {
    participants.set(message.userId, message.senderName);
  }

  for (const message of recentMessages) {
    if (message.kind === "user_message" || message.kind === "assistant_message") {
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
        displayName: user?.nickname ?? displayName,
        relationshipLabel,
        ...(user?.preferredAddress ? { preferredAddress: user.preferredAddress } : {}),
        ...(user?.gender ? { gender: user.gender } : {}),
        ...(user?.residence ? { residence: user.residence } : {}),
        ...(user?.profileSummary ? { profileSummary: user.profileSummary } : {}),
        ...(user?.sharedContext ? { sharedContext: user.sharedContext } : {})
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
