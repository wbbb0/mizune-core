import type { Logger } from "pino";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { SessionDelivery } from "#conversation/session/sessionTypes.ts";
import { collectVisualAttachmentFileIds } from "#services/workspace/chatAttachments.ts";
import type {
  MessageEventHandlerDeps,
  MessageHandlerServices,
  MessageProcessingContext,
  TriggerDecision
} from "./messageHandlerTypes.ts";
import {
  appendIncomingHistoryTranscript,
  resolveIncomingOneBotSourceRef
} from "./incomingHistory.ts";

export async function resolveTriggerDecision(
  services: Pick<
    MessageHandlerServices,
    "config" | "whitelistStore" | "conversationAccess" | "sessionManager"
  >,
  context: MessageProcessingContext
): Promise<TriggerDecision> {
  const groupMatched = context.enrichedMessage.groupId != null
    && services.whitelistStore.hasGroup(context.enrichedMessage.groupId);
  if (context.enrichedMessage.groupId) {
    await services.conversationAccess.recordSeenGroupMember(
      context.enrichedMessage.groupId,
      context.enrichedMessage.userId
    );
  }
  const matchedPendingGroupTrigger = context.enrichedMessage.chatType === "group"
    && !context.enrichedMessage.isAtMentioned
    && services.sessionManager.matchesInterruptibleGroupTriggerUser(
      context.session.id,
      context.enrichedMessage.userId
    );
  const shouldTriggerResponse = context.enrichedMessage.chatType === "private"
    ? true
    : (
        (context.enrichedMessage.isAtMentioned || matchedPendingGroupTrigger)
        && (
          context.user.relationship === "owner"
          || !services.config.whitelist.enabled
          || groupMatched
        )
      );

  return {
    groupMatched,
    matchedPendingGroupTrigger,
    shouldTriggerResponse
  };
}

export function appendIncomingHistory(
  sessionManager: MessageHandlerServices["sessionManager"],
  logger: Logger,
  context: MessageProcessingContext
): void {
  const sourceRef = resolveIncomingOneBotSourceRef(context.enrichedMessage);
  appendIncomingHistoryTranscript(sessionManager, context, {
    timestampMs: Date.now(),
    ...(sourceRef ? { sourceRef } : {})
  });
  logger.info(
    {
      sessionId: context.session.id,
      role: "user",
      contentLength: context.enrichedMessage.text.length,
      imageCount: context.enrichedMessage.images.length,
      audioCount: context.enrichedMessage.audioSources.length,
      imageIdCount: context.enrichedMessage.imageIds.length,
      emojiIdCount: context.enrichedMessage.emojiIds.length,
      forwardCount: context.enrichedMessage.forwardIds.length,
      replyMessageId: context.enrichedMessage.replyMessageId,
      mentionUserCount: context.enrichedMessage.mentionUserIds.length,
      mentionedAll: context.enrichedMessage.mentionedAll,
      mentionedSelf: context.enrichedMessage.isAtMentioned,
      contentPreview: context.enrichedMessage.text.slice(0, 120)
    },
    "history_user_appended"
  );
}

export function handleNonTriggeringMessage(
  sessionManager: MessageHandlerServices["sessionManager"],
  logger: Logger,
  persistSession: MessageEventHandlerDeps["persistSession"],
  context: MessageProcessingContext,
  triggerDecision: TriggerDecision
): boolean {
  if (triggerDecision.shouldTriggerResponse) {
    return false;
  }

  if (context.session.pendingMessages.length === 0 && context.session.pendingSteerMessages.length === 0) {
    sessionManager.clearPendingTranscriptGroup(context.session.id);
  }
  persistSession(context.session.id, "group_message_monitored");
  logger.info(
    {
      sessionId: context.session.id,
      chatType: context.enrichedMessage.chatType,
      userId: context.enrichedMessage.userId,
      groupId: context.enrichedMessage.groupId,
      atMentioned: context.enrichedMessage.isAtMentioned,
      relationship: context.user.relationship,
      groupMatched: triggerDecision.groupMatched
    },
    "message_monitored_no_trigger"
  );
  return true;
}

function shouldUpdateSessionReplyDelivery(
  inboundDelivery: SessionDelivery,
  message: Pick<ParsedIncomingMessage, "chatType" | "isAtMentioned">
): boolean {
  return inboundDelivery === "web" || message.chatType === "private" || message.isAtMentioned;
}

export function enqueueTriggeredMessage(
  services: Pick<
    MessageHandlerServices,
    "sessionManager" | "debounceManager" | "mediaCaptionService"
  >,
  inboundDelivery: SessionDelivery,
  context: MessageProcessingContext,
  persistSession: MessageEventHandlerDeps["persistSession"],
  flushSession: MessageEventHandlerDeps["flushSession"],
  logger: Logger,
  options?: {
    activeResponseAlreadyInterrupted?: boolean;
  }
): void {
  if (shouldUpdateSessionReplyDelivery(inboundDelivery, context.enrichedMessage)) {
    services.sessionManager.setReplyDelivery(context.session.id, inboundDelivery);
  }

  if (context.enrichedMessage.chatType === "group") {
    services.sessionManager.setInterruptibleGroupTriggerUser(context.session.id, context.enrichedMessage.userId);
  }

  services.mediaCaptionService.schedule(
    [
      ...collectVisualAttachmentFileIds(context.enrichedMessage.attachments, "image"),
      ...collectVisualAttachmentFileIds(context.enrichedMessage.attachments, "emoji")
    ],
    context.enrichedMessage.chatType === "private" ? "incoming_private_message" : "incoming_group_trigger"
  );

  if (options?.activeResponseAlreadyInterrupted || services.sessionManager.hasActiveResponse(context.session.id)) {
    // Natural user input is treated as an interruption: stop the active turn and
    // queue the new message exactly once for the next debounced response.
    const interrupted = options?.activeResponseAlreadyInterrupted
      ? null
      : services.sessionManager.interruptResponse(context.session.id);
    services.sessionManager.appendPendingMessage(context.session.id, context.enrichedMessage);
    persistSession(context.session.id, "user_message_interrupted_active_response");
    services.debounceManager.schedule(context.session.id, () => {
      flushSession(context.session.id);
    });
    if (!options?.activeResponseAlreadyInterrupted) {
      logger.info({ sessionId: context.session.id, interrupted }, "user_message_interrupted_active_response");
    }
    return;
  }

  services.sessionManager.appendPendingMessage(context.session.id, context.enrichedMessage);
  persistSession(context.session.id, "user_message_received");
  services.debounceManager.schedule(context.session.id, () => {
    flushSession(context.session.id);
  });
}
