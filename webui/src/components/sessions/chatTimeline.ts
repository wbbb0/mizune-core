import type { TranscriptItem as SessionTranscriptItem } from "../../api/types.ts";

export interface ChatTimelineTranscriptEntry {
  id: string;
  eventId: string;
  index: number;
  item: SessionTranscriptItem;
}

export type ChatTimelineContentPart =
  | { kind: "text"; text: string }
  | { kind: "image" | "emoji"; fileId: string; imageUrl: string; sourceName: string | null }
  | { kind: "file"; fileId: string; name: string | null; sizeBytes: number | null; mimeType: string | null; fileKind: string | null; contentUrl: string | null }
  | { kind: "meta"; text: string };

export type ChatTimelineItem =
  | {
      id: string;
      itemId: string;
      groupId: string;
      actionTitle: string;
      kind: "content_parts";
      role: "user" | "assistant";
      side: "left" | "right";
      parts: ChatTimelineContentPart[];
      senderLabel?: string;
      metaChips?: string[];
      actionsEnabled?: boolean;
      timestampMs: number;
    }
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
      senderLabel?: string;
      metaChips?: string[];
      actionsEnabled?: boolean;
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

  if (entry.item.kind === "user_message" || entry.item.kind === "user_media_message" || entry.item.kind === "assistant_message") {
    const side = resolveMessageSide(entry.item, activeComposerUserId);
    if (entry.item.kind === "user_media_message") {
      return [buildUserContentPartsItem(entry, side, entry.item.mediaKind === "emoji" ? "表情消息" : entry.item.mediaKind === "image" ? "图片消息" : "媒体消息")];
    }
    if (entry.item.kind === "user_message" && (entry.item.contentParts?.length ?? 0) > 0) {
      return [buildUserContentPartsItem(entry, side, "消息")];
    }
    const imageItems = entry.item.kind === "user_message"
      ? buildUserImageItems(entry, side)
      : [];
    const senderLabel = formatSenderLabel(entry.item);
    const metaChips = buildMetaChips(entry.item, imageItems.length);
    const content = entry.item.kind === "user_message" ? buildUserMessageContent(entry.item) : entry.item.text;
    const textItem = content
      ? {
          id: entry.id,
          itemId: entry.item.id,
          groupId: entry.item.groupId,
          actionTitle: entry.item.kind === "user_message" ? "消息" : "回复",
          kind: "text" as const,
          role: entry.item.role,
          side,
          content,
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
    if (entry.item.mediaKind === "file") {
      const contentUrl = entry.item.fileId
        ? getChatFileContentUrlById(entry.item.fileId)
        : (entry.item.sourcePath ? getLocalSendFileContentUrl(entry.item.sourcePath) : null);
      return [{
        id: entry.id,
        itemId: entry.item.id,
        groupId: entry.item.groupId,
        actionTitle: "文件消息",
        kind: "content_parts",
        role: "assistant",
        side: "left",
        parts: [{
          kind: "file",
          fileId: entry.item.fileId ?? entry.item.sourcePath ?? entry.item.id,
          name: entry.item.sourceName,
          sizeBytes: entry.item.sizeBytes ?? null,
          mimeType: entry.item.mimeType ?? null,
          fileKind: "file",
          contentUrl
        }],
        metaChips: [entry.item.toolName],
        timestampMs: entry.item.timestampMs
      }];
    }

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

function buildUserContentPartsItem(
  entry: ChatTimelineTranscriptEntry,
  side: "left" | "right",
  actionTitle: string
): ChatTimelineItem {
  if (entry.item.kind !== "user_message" && entry.item.kind !== "user_media_message") {
    throw new Error("content parts timeline item requires a user transcript item");
  }
  const senderLabel = formatSenderLabel(entry.item);
  const parts = buildTimelineContentParts(entry.item);
  const metaChips = buildMetaChips(entry.item, parts.filter((part) => part.kind === "image" || part.kind === "emoji").length);
  return {
    id: entry.id,
    itemId: entry.item.id,
    groupId: entry.item.groupId,
    actionTitle,
    kind: "content_parts",
    role: "user",
    side,
    parts,
    ...(senderLabel ? { senderLabel } : {}),
    ...(metaChips.length > 0 ? { metaChips } : {}),
    timestampMs: entry.item.timestampMs
  };
}

function buildTimelineContentParts(
  item: Extract<SessionTranscriptItem, { kind: "user_message" | "user_media_message" }>
): ChatTimelineContentPart[] {
  const parts: ChatTimelineContentPart[] = [];
  for (const part of item.contentParts ?? []) {
    switch (part.kind) {
      case "text":
        if (part.text.trim()) {
          parts.push({ kind: "text", text: part.text.trim() });
        }
        break;
      case "image":
      case "emoji":
        if (part.fileId && isResolvedChatFileId(part.fileId)) {
          parts.push({
            kind: part.kind,
            fileId: part.fileId,
            imageUrl: getChatFileContentUrlById(part.fileId),
            sourceName: part.sourceName ?? null
          });
        } else {
          parts.push({ kind: "meta", text: formatUnresolvedMediaPart(part.kind, part.sourceName ?? part.source ?? part.fileId ?? null) });
        }
        break;
      case "file":
        parts.push({
          kind: "file",
          fileId: part.file.fileId,
          name: part.file.name,
          sizeBytes: part.file.sizeBytes,
          mimeType: part.file.mimeType,
          fileKind: null,
          contentUrl: null
        });
        break;
      case "asset_file":
        parts.push({
          kind: "file",
          fileId: part.fileId,
          name: part.sourceName,
          sizeBytes: part.sizeBytes,
          mimeType: part.mimeType,
          fileKind: part.fileKind,
          contentUrl: isResolvedChatFileId(part.fileId) ? getChatFileContentUrlById(part.fileId) : null
        });
        break;
      case "reply":
        parts.push({ kind: "meta", text: `回复：${part.messageId}` });
        break;
      case "mention":
        parts.push({ kind: "meta", text: part.target === "all" ? "@全体" : part.target === "self" ? "@我" : `@${part.userId ?? "unknown"}` });
        break;
      case "forward":
        parts.push({ kind: "meta", text: `转发：${part.forwardId}` });
        break;
      case "audio":
        parts.push({ kind: "meta", text: "语音消息" });
        break;
      case "special":
        parts.push({ kind: "meta", text: part.summary });
        break;
    }
  }
  return parts.length > 0 ? parts : [{ kind: "text", text: buildUserMessageContent(item) || "<empty>" }];
}

function formatUnresolvedMediaPart(kind: "image" | "emoji", label: string | null): string {
  return `${kind === "emoji" ? "表情" : "图片"}待解析${label ? `：${label}` : ""}`;
}

function buildUserMessageContent(item: Extract<SessionTranscriptItem, { kind: "user_message" | "user_media_message" }>): string {
  if (item.kind === "user_media_message") {
    return "";
  }
  return [
    item.text.trim(),
    ...(item.messageFiles ?? []).map((file) => `文件：${file.name || file.fileId}`),
    ...(item.specialSegments ?? []).map((segment) => segment.summary)
  ].filter(Boolean).join("\n");
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
  const senderLabel = formatSenderLabel(entry.item);
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
      ...(senderLabel ? { senderLabel } : {}),
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
      ...(senderLabel ? { senderLabel } : {}),
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
      ...(senderLabel ? { senderLabel } : {}),
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

function formatSenderLabel(item: Extract<SessionTranscriptItem, { kind: "user_message" | "user_media_message" | "assistant_message" }>): string | undefined {
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
  item: Extract<SessionTranscriptItem, { kind: "user_message" | "user_media_message" | "assistant_message" }>,
  renderedImageCount: number
): string[] {
  if (item.kind !== "user_message" && item.kind !== "user_media_message") {
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
  if (item.kind === "user_message") {
    if ((item.messageFiles?.length ?? 0) > 0) chips.push(`文件 ${item.messageFiles?.length ?? 0}`);
    if ((item.specialSegments?.length ?? 0) > 0) chips.push(`消息段 ${item.specialSegments?.length ?? 0}`);
    if (item.audioCount > 0) chips.push(`语音 ${item.audioCount}`);
    if (item.forwardIds.length > 0) chips.push(`转发 ${item.forwardIds.length}`);
  }
  return chips;
}

function isResolvedChatFileId(fileId: string | null | undefined): boolean {
  const normalized = String(fileId ?? "").trim();
  return normalized.length > 0 && !normalized.startsWith("pending:");
}

function resolveMessageSide(
  item: Extract<SessionTranscriptItem, { kind: "user_message" | "user_media_message" | "assistant_message" }>,
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
