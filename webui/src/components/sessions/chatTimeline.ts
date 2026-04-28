import type { TranscriptItem as SessionTranscriptItem } from "../../api/types.ts";

export interface ChatTimelineTranscriptEntry {
  id: string;
  eventId: string;
  index: number;
  item: SessionTranscriptItem;
}

export type ChatTimelineItem =
  | {
      id: string;
      itemId: string;
      groupId: string;
      actionTitle: string;
      kind: "text";
      role: "user" | "assistant";
      side: "left" | "right";
      content: string;
      senderLabel?: string;
      metaChips?: string[];
      timestampMs: number;
      label?: string;
      streaming?: boolean;
      actionsEnabled?: boolean;
    }
  | {
      id: string;
      itemId: string;
      groupId: string;
      actionTitle: string;
      kind: "image";
      role: "user" | "assistant";
      side: "left" | "right";
      sourceName: string | null;
      fileRef: string | null;
      fileId: string | null;
      imageUrl: string;
      toolName?: string;
      timestampMs: number;
    };

export function buildChatTimelineItems(
  transcript: ChatTimelineTranscriptEntry[],
  options: {
    activeComposerUserId?: string | null;
    draftAssistantText?: string | null;
    draftTurnId?: string | null;
  } = {}
): ChatTimelineItem[] {
  const items = [...transcript]
    .reverse()
    .flatMap((entry) => toChatTimelineItems(entry, options.activeComposerUserId ?? null));
  const draftAssistantText = options.draftAssistantText ?? null;
  if (!draftAssistantText || draftAssistantText.trim().length === 0) {
    return items;
  }
  return [buildDraftAssistantItem({
    transcript,
    content: draftAssistantText,
    turnId: options.draftTurnId ?? null
  }), ...items];
}

function toChatTimelineItems(
  entry: ChatTimelineTranscriptEntry,
  activeComposerUserId: string | null
): ChatTimelineItem[] {
  if (entry.item.runtimeExcluded) {
    return [];
  }

  if (entry.item.kind === "user_message" || entry.item.kind === "assistant_message") {
    const side = resolveMessageSide(entry.item, activeComposerUserId);
    const imageItems = entry.item.kind === "user_message"
      ? buildUserImageItems(entry, side)
      : [];
    const senderLabel = formatSenderLabel(entry.item);
    const metaChips = buildMetaChips(entry.item, imageItems.length);
    const textItem = entry.item.text
      ? {
          id: entry.id,
          itemId: entry.item.id,
          groupId: entry.item.groupId,
          actionTitle: entry.item.kind === "user_message" ? "消息" : "回复",
          kind: "text" as const,
          role: entry.item.role,
          side,
          content: entry.item.text,
          ...(senderLabel ? { senderLabel } : {}),
          ...(metaChips.length > 0 ? { metaChips } : {}),
          timestampMs: entry.item.timestampMs
        }
      : null;
    return [...(textItem ? [textItem] : []), ...imageItems];
  }

  if (entry.item.kind === "direct_command") {
    return [{
      id: entry.id,
      itemId: entry.item.id,
      groupId: entry.item.groupId,
      actionTitle: "指令消息",
      kind: "text",
      role: entry.item.role,
      side: entry.item.role === "user" ? "right" : "left",
      content: entry.item.content,
      timestampMs: entry.item.timestampMs,
      label: entry.item.direction === "input"
        ? `指令输入 · ${entry.item.commandName}`
        : `指令输出 · ${entry.item.commandName}`
    }];
  }

  if (entry.item.kind === "outbound_media_message") {
    const imageUrl = entry.item.fileId
      ? getChatFileContentUrlById(entry.item.fileId)
      : (entry.item.sourcePath ? getLocalSendFileContentUrl(entry.item.sourcePath) : "");
    if (!imageUrl) {
      return [];
    }
    return [{
      id: entry.id,
      itemId: entry.item.id,
      groupId: entry.item.groupId,
      actionTitle: "图片消息",
      kind: "image",
      role: "assistant",
      side: "left",
      sourceName: entry.item.sourceName,
      fileRef: entry.item.fileRef,
      fileId: entry.item.fileId,
      imageUrl,
      toolName: entry.item.toolName,
      timestampMs: entry.item.timestampMs
    }];
  }

  return [];
}

function buildDraftAssistantItem(input: {
  transcript: ChatTimelineTranscriptEntry[];
  content: string;
  turnId: string | null;
}): ChatTimelineItem {
  const latestTimestampMs = input.transcript.at(-1)?.item.timestampMs ?? Date.now();
  const draftId = input.turnId ? `draft:${input.turnId}` : "draft:assistant";
  return {
    id: draftId,
    itemId: draftId,
    groupId: draftId,
    actionTitle: "流式回复",
    kind: "text",
    role: "assistant",
    side: "left",
    content: input.content,
    timestampMs: latestTimestampMs,
    label: "生成中",
    streaming: true,
    actionsEnabled: false
  };
}

function buildUserImageItems(
  entry: ChatTimelineTranscriptEntry,
  side: "left" | "right"
): ChatTimelineItem[] {
  if (entry.item.kind !== "user_message") {
    return [];
  }
  const attachments = entry.item.attachments ?? [];
  const visualAttachments = attachments.filter((item) => (
    isResolvedChatFileId(item.fileId)
    &&
    (item.kind === "image" || item.kind === "animated_image")
  ));
  const seen = new Set(visualAttachments.map((item) => item.fileId));
  const fallbackFileIds = entry.item.imageIds.filter((fileId) => isResolvedChatFileId(fileId) && !seen.has(fileId));
  for (const fileId of fallbackFileIds) {
    seen.add(fileId);
  }
  const fallbackEmojiFileIds = entry.item.emojiIds.filter((fileId) => isResolvedChatFileId(fileId) && !seen.has(fileId));

  return [
    ...visualAttachments.map((item, index) => ({
      id: `${entry.id}:image:${index}`,
      itemId: entry.item.id,
      groupId: entry.item.groupId,
      actionTitle: item.semanticKind === "emoji" ? "表情消息" : "图片消息",
      kind: "image" as const,
      role: "user" as const,
      side,
      sourceName: item.sourceName,
      fileRef: null,
      fileId: item.fileId,
      imageUrl: getChatFileContentUrlById(item.fileId),
      timestampMs: entry.item.timestampMs
    })),
    ...fallbackFileIds.map((fileId, index) => ({
      id: `${entry.id}:image:fallback:${index}`,
      itemId: entry.item.id,
      groupId: entry.item.groupId,
      actionTitle: "图片消息",
      kind: "image" as const,
      role: "user" as const,
      side,
      sourceName: null,
      fileRef: null,
      fileId,
      imageUrl: getChatFileContentUrlById(fileId),
      timestampMs: entry.item.timestampMs
    })),
    ...fallbackEmojiFileIds.map((fileId, index) => ({
      id: `${entry.id}:emoji:fallback:${index}`,
      itemId: entry.item.id,
      groupId: entry.item.groupId,
      actionTitle: "表情消息",
      kind: "image" as const,
      role: "user" as const,
      side,
      sourceName: null,
      fileRef: null,
      fileId,
      imageUrl: getChatFileContentUrlById(fileId),
      timestampMs: entry.item.timestampMs
    }))
  ];
}

function getChatFileContentUrlById(fileId: string): string {
  return `/api/chat-files/${encodeURIComponent(fileId)}/content`;
}

function getLocalSendFileContentUrl(path: string): string {
  return `/api/local-files/send-content?path=${encodeURIComponent(path)}`;
}

function formatSenderLabel(item: Extract<SessionTranscriptItem, { kind: "user_message" | "assistant_message" }>): string | undefined {
  if (item.chatType === "private" && item.kind === "assistant_message") {
    return undefined;
  }
  const name = item.senderName.trim();
  const userId = item.userId.trim();
  if (!name) {
    return userId || undefined;
  }
  if (!userId || userId === name) {
    return name;
  }
  return `${name} · ${userId}`;
}

function buildMetaChips(
  item: Extract<SessionTranscriptItem, { kind: "user_message" | "assistant_message" }>,
  renderedImageCount: number
): string[] {
  if (item.kind !== "user_message") {
    return [];
  }
  const chips: string[] = [];
  if (item.replyMessageId) chips.push("回复");
  if (item.mentionedSelf) chips.push("@我");
  if (item.mentionedAll) chips.push("@全体");
  const resolvedImageIdCount = item.imageIds.filter(isResolvedChatFileId).length;
  const resolvedEmojiIdCount = item.emojiIds.filter(isResolvedChatFileId).length;
  if (resolvedImageIdCount > 0 && renderedImageCount === 0) chips.push(`图片 ${resolvedImageIdCount}`);
  if (resolvedEmojiIdCount > 0) chips.push(`表情 ${resolvedEmojiIdCount}`);
  if (item.audioCount > 0) chips.push(`语音 ${item.audioCount}`);
  if (item.forwardIds.length > 0) chips.push(`转发 ${item.forwardIds.length}`);
  return chips;
}

function isResolvedChatFileId(fileId: string | null | undefined): boolean {
  const normalized = String(fileId ?? "").trim();
  return normalized.length > 0 && !normalized.startsWith("pending:");
}

function resolveMessageSide(
  item: Extract<SessionTranscriptItem, { kind: "user_message" | "assistant_message" }>,
  activeComposerUserId: string | null
): "left" | "right" {
  if (item.chatType === "private") {
    return item.role === "user" ? "right" : "left";
  }
  if (item.role !== "user") {
    return "left";
  }
  return activeComposerUserId && item.userId === activeComposerUserId ? "right" : "left";
}
