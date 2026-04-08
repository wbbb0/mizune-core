import {
  extractAudioSources,
  extractFileSources,
  extractForwardIds,
  extractMediaSources,
  extractMentions,
  extractReplyMessageId,
  extractText
} from "./messageSegments.ts";
import type { OneBotMessageEvent, ParsedIncomingMessage } from "./types.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";

export function extractEventMessageText(event: OneBotMessageEvent): string {
  const text = extractText(event.message).trim();
  if (text) {
    return text;
  }

  const hasOnlyText = event.message.every((segment) => segment.type === "text");
  if (hasOnlyText) {
    return event.raw_message.trim();
  }

  return "";
}

export function isAtMentionedSelf(event: OneBotMessageEvent): boolean {
  const mentions = extractMentions(event.message, event.self_id);
  return mentions.mentionedAll || mentions.mentionedSelf;
}

export function parseIncomingMessage(event: OneBotMessageEvent): ParsedIncomingMessage | null {
  const text = extractEventMessageText(event);
  const mediaSources = extractMediaSources(event.message);
  const images = mediaSources.map((item) => item.source);
  const audioSources = extractAudioSources(event.message);
  const fileSources = extractFileSources(event.message);
  const emojiSources = mediaSources
    .filter((item) => item.kind === "emoji")
    .map((item) => item.source);
  const forwardIds = extractForwardIds(event.message);
  const replyMessageId = extractReplyMessageId(event.message);
  const mentions = extractMentions(event.message, event.self_id);

  if (
    !text
    && images.length === 0
    && audioSources.length === 0
    && fileSources.length === 0
    && forwardIds.length === 0
    && !replyMessageId
    && !mentions.mentionedAll
    && !mentions.mentionedSelf
    && mentions.userIds.length === 0
  ) {
    return null;
  }

  return {
    chatType: event.message_type,
    userId: String(event.user_id),
    ...(event.group_id != null ? { groupId: String(event.group_id) } : {}),
    senderName: event.sender.card || event.sender.nickname || String(event.user_id),
    text,
    images,
    audioSources,
    audioIds: [],
    emojiSources,
    imageIds: [],
    emojiIds: [],
    attachments: buildInitialAttachments(images, fileSources),
    forwardIds,
    replyMessageId,
    mentionUserIds: mentions.userIds,
    mentionedAll: mentions.mentionedAll,
    isAtMentioned: event.message_type === "group" ? isAtMentionedSelf(event) : false,
    rawEvent: event
  };
}

function buildInitialAttachments(
  images: string[],
  fileSources: Array<{ source: string; filename: string | null; mimeType: string | null }>
): ChatAttachment[] {
  return [
    ...images.map((source, index) => ({
      fileId: `pending:image:${index}:${source}`,
      kind: "image" as const,
      source: "chat_message" as const,
      sourceName: null,
      mimeType: null
    })),
    ...fileSources.map((item, index) => ({
      fileId: `pending:file:${index}:${item.source}`,
      kind: "file" as const,
      source: "chat_message" as const,
      sourceName: item.filename,
      mimeType: item.mimeType
    }))
  ];
}
