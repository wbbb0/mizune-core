import type { SessionMessagingAccess } from "#conversation/session/sessionCapabilities.ts";
import type { TranscriptItemSourceRef } from "#conversation/session/sessionTypes.ts";
import { normalizeOneBotMessageId } from "#services/onebot/messageId.ts";
import type { OneBotMessageEvent } from "#services/onebot/types.ts";
import type { MessageProcessingContext } from "./messageHandlerTypes.ts";

export function resolveIncomingOneBotSourceRef(
  message: Pick<MessageProcessingContext["enrichedMessage"], "rawEvent">
): TranscriptItemSourceRef | undefined {
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
    ...(context.enrichedMessage.imageIds.length > 0 ? { imageIds: context.enrichedMessage.imageIds } : {}),
    ...(context.enrichedMessage.emojiIds.length > 0 ? { emojiIds: context.enrichedMessage.emojiIds } : {}),
    ...(context.enrichedMessage.attachments ? { attachments: context.enrichedMessage.attachments } : {}),
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
  }
): void {
  sessionManager.appendUserHistory(
    context.session.id,
    createIncomingHistoryMessage(context, input.sourceRef),
    input.timestampMs
  );
}
