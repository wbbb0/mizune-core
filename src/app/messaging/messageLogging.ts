import type { Logger } from "pino";
import type { OneBotMessageEvent } from "#services/onebot/types.ts";
import { extractFileSources, extractText, summarizeSegment } from "#services/onebot/messageSegments.ts";
import type { MessageProcessingContext, TriggerDecision } from "./messageHandlerTypes.ts";

function summarizeIgnoredMessageSegments(message: Array<{ type: string; data: Record<string, unknown> }>): Array<{
  type: string;
  data: Record<string, string>;
}> {
  return message.map((segment) => ({
    type: segment.type,
    data: Object.fromEntries(
      Object.entries(segment.data ?? {}).map(([key, value]) => [key, summarizeUnknownValue(value)])
    )
  }));
}

function summarizeNonTextSegments(message: Array<{ type: string; data: Record<string, unknown> }>): Array<{
  type: string;
  summary: string;
}> {
  return message
    .filter((segment) => segment.type !== "text" && segment.type !== "at")
    .map((segment) => ({
      type: segment.type,
      summary: truncateForLog(summarizeSegment(segment))
    }));
}

function summarizeUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return truncateForLog(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return String(value);
  }
  try {
    return truncateForLog(JSON.stringify(value));
  } catch {
    return truncateForLog(String(value));
  }
}

function truncateForLog(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength)}...`;
}

export function resolveRawText(event: OneBotMessageEvent): string {
  return extractText(event.message).trim() || event.raw_message.trim();
}

export function logIgnoredMessage(logger: Logger, event: OneBotMessageEvent): void {
  logger.debug(
    {
      messageType: event.message_type,
      userId: String(event.user_id),
      groupId: event.group_id != null ? String(event.group_id) : undefined,
      rawMessagePreview: truncateForLog(event.raw_message),
      segmentCount: event.message.length,
      segments: summarizeIgnoredMessageSegments(event.message)
    },
    "message_ignored"
  );
}

export function logReceivedMessage(
  logger: Logger,
  context: MessageProcessingContext,
  triggerDecision: TriggerDecision
): void {
  const rawSegments = context.enrichedMessage.rawEvent?.message ?? [];
  const fileSources = extractFileSources(rawSegments);
  logger.info(
    {
      sessionId: context.session.id,
      chatType: context.enrichedMessage.chatType,
      userId: context.enrichedMessage.userId,
      groupId: context.enrichedMessage.groupId,
      atMentioned: context.enrichedMessage.isAtMentioned,
      matchedPendingGroupTrigger: triggerDecision.matchedPendingGroupTrigger,
      text: context.enrichedMessage.text,
      imageCount: context.enrichedMessage.images.length,
      audioCount: context.enrichedMessage.audioSources.length,
      imageIdCount: context.enrichedMessage.imageIds.length,
      emojiIdCount: context.enrichedMessage.emojiIds.length,
      attachmentCount: context.enrichedMessage.attachments?.length ?? 0,
      rawSegmentCount: rawSegments.length,
      rawSegmentTypes: rawSegments.map((segment) => segment.type),
      nonTextSegments: summarizeNonTextSegments(rawSegments),
      fileSegmentCount: rawSegments.filter((segment) => segment.type === "file").length,
      fileSourceCount: fileSources.length,
      fileSources: fileSources.map((fileSource) => ({
        sourceKind: fileSource.sourceKind,
        ...(fileSource.sourceKind === "direct" ? { source: truncateForLog(fileSource.source) } : {}),
        ...(fileSource.fileId ? { fileId: fileSource.fileId } : {}),
        ...(fileSource.busid != null ? { busid: fileSource.busid } : {}),
        filename: fileSource.filename,
        mimeType: fileSource.mimeType,
        sizeBytes: fileSource.sizeBytes
      })),
      forwardCount: context.enrichedMessage.forwardIds.length,
      replyMessageId: context.enrichedMessage.replyMessageId,
      mentionUserCount: context.enrichedMessage.mentionUserIds.length,
      mentionedAll: context.enrichedMessage.mentionedAll,
      relationship: context.user.relationship
    },
    "message_received"
  );
}
