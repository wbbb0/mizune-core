import type { SessionMessagingAccess } from "#conversation/session/sessionCapabilities.ts";
import { transcriptMessageContentPartsSchema } from "#conversation/session/transcriptContract.ts";
import type { TranscriptItemSourceRef } from "#conversation/session/sessionTypes.ts";
import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import type { OneBotMessageEvent } from "#services/onebot/types.ts";
import type { MessageProcessingContext } from "./messageHandlerTypes.ts";

export function resolveIncomingSourceRef(
  message: Pick<MessageProcessingContext["enrichedMessage"], "rawEvent" | "sourceRef">
): TranscriptItemSourceRef | undefined {
  if (message.sourceRef) return message.sourceRef;
  const messageId = normalizeOneBotMessageId(message.rawEvent?.message_id);
  return messageId == null
    ? undefined
    : {
        platform: "onebot",
        messageId
      };
}

export function resolveOneBotEventSourceRef(event: Pick<OneBotMessageEvent, "message_id">): TranscriptItemSourceRef | undefined {
  const messageId = normalizeOneBotMessageId(event.message_id);
  return messageId == null
    ? undefined
    : {
        platform: "onebot",
        messageId
      };
}

export function createIncomingHistoryMessage(
  context: MessageProcessingContext,
  sourceRef?: TranscriptItemSourceRef
): Parameters<SessionMessagingAccess["appendUserHistory"]>[1] {
  return {
    chatType: context.enrichedMessage.chatType,
    userId: context.enrichedMessage.userId,
    senderName: context.enrichedMessage.senderName,
    text: context.enrichedMessage.text,
    ...(context.enrichedMessage.contentParts && context.enrichedMessage.contentParts.length > 0
      ? { contentParts: transcriptMessageContentPartsSchema.parse(context.enrichedMessage.contentParts) }
      : {}),
    ...(context.enrichedMessage.imageIds.length > 0 ? { imageIds: context.enrichedMessage.imageIds } : {}),
    ...(context.enrichedMessage.emojiIds.length > 0 ? { emojiIds: context.enrichedMessage.emojiIds } : {}),
    ...(context.enrichedMessage.attachments ? { attachments: context.enrichedMessage.attachments } : {}),
    ...(context.enrichedMessage.messageFiles && context.enrichedMessage.messageFiles.length > 0 ? { messageFiles: context.enrichedMessage.messageFiles } : {}),
    ...(context.enrichedMessage.specialSegments ? { specialSegments: context.enrichedMessage.specialSegments } : {}),
    audioCount: context.enrichedMessage.audioSources.length,
    forwardIds: context.enrichedMessage.forwardIds,
    replyMessageId: context.enrichedMessage.replyMessageId,
    mentionUserIds: context.enrichedMessage.mentionUserIds,
    mentionedAll: context.enrichedMessage.mentionedAll,
    mentionedSelf: context.enrichedMessage.isAtMentioned,
    ...(sourceRef ? { sourceRef } : {}),
    ...(context.contentSafetyEvents && context.contentSafetyEvents.length > 0
      ? { contentSafetyEvents: context.contentSafetyEvents }
      : {})
  };
}

export function appendIncomingHistoryTranscript(
  sessionManager: Pick<SessionMessagingAccess, "appendUserHistory">,
  context: MessageProcessingContext,
  input: {
    timestampMs: number;
    sourceRef?: TranscriptItemSourceRef;
    transcriptGroup?: "pending" | "standalone";
    transcriptGroupId?: string;
  }
): void {
  sessionManager.appendUserHistory(
    context.session.id,
    createIncomingHistoryMessage(context, input.sourceRef),
    input.timestampMs,
    input.transcriptGroup || input.transcriptGroupId || context.enrichedMessage.activationUpgrade
      ? {
          ...(context.enrichedMessage.activationUpgrade ? { upsertSource: true } : {}),
          ...(input.transcriptGroup ? { transcriptGroup: input.transcriptGroup } : {}),
          ...(input.transcriptGroupId ? { transcriptGroupId: input.transcriptGroupId } : {})
        }
      : undefined
  );
}

/** Persisted mention state prevents a replay after reconnect/restart from activating twice. */
export function canActivateRecordedGroupContext(
  message: MessageProcessingContext["enrichedMessage"],
  items: readonly import("#conversation/session/sessionTypes.ts").InternalTranscriptItem[]
): boolean {
  const source = message.sourceRef;
  if (message.source !== "qq_official" || message.chatType !== "group" || message.contextOnly
    || !message.isAtMentioned || !message.replyContext || !source) return false;
  // A command consumes this source without promoting its passive copy into prompt history.
  if (items.some(item => item.kind === "direct_command" && item.direction === "input"
    && item.sourceRef?.platform === "qq_official" && item.sourceRef.connectionId === source.connectionId
    && item.sourceRef.messageId === source.messageId)) return false;
  const existing = items.find(item => item.kind === "user_message" && item.sourceRef?.platform === "qq_official"
    && item.sourceRef.connectionId === source.connectionId && item.sourceRef.messageId === source.messageId);
  return existing?.kind === "user_message" && existing.mentionedSelf !== true;
}
