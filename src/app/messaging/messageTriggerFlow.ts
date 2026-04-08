import type { Logger } from "pino";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { SessionDelivery } from "#conversation/session/sessionTypes.ts";
import type {
  MessageEventHandlerDeps,
  MessageHandlerServices,
  MessageProcessingContext,
  TriggerDecision
} from "./messageHandlerTypes.ts";

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
  sessionManager.appendUserHistory(context.session.id, {
    chatType: context.enrichedMessage.chatType,
    userId: context.enrichedMessage.userId,
    senderName: context.enrichedMessage.senderName,
    text: context.enrichedMessage.text,
    ...(context.enrichedMessage.attachments ? { attachments: context.enrichedMessage.attachments } : {}),
    audioCount: context.enrichedMessage.audioSources.length,
    forwardIds: context.enrichedMessage.forwardIds,
    replyMessageId: context.enrichedMessage.replyMessageId,
    mentionUserIds: context.enrichedMessage.mentionUserIds,
    mentionedAll: context.enrichedMessage.mentionedAll,
    mentionedSelf: context.enrichedMessage.isAtMentioned
  }, Date.now());
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
  logger: Logger,
  persistSession: MessageEventHandlerDeps["persistSession"],
  context: MessageProcessingContext,
  triggerDecision: TriggerDecision
): boolean {
  if (triggerDecision.shouldTriggerResponse) {
    return false;
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
  logger: Logger
): void {
  if (shouldUpdateSessionReplyDelivery(inboundDelivery, context.enrichedMessage)) {
    services.sessionManager.setReplyDelivery(context.session.id, inboundDelivery);
  }

  if (context.enrichedMessage.chatType === "group") {
    services.sessionManager.setInterruptibleGroupTriggerUser(context.session.id, context.enrichedMessage.userId);
  }

  services.mediaCaptionService.schedule(
    (context.enrichedMessage.attachments ?? [])
      .filter((item) => item.kind === "image" || item.kind === "animated_image")
      .map((item) => item.fileId),
    context.enrichedMessage.chatType === "private" ? "incoming_private_message" : "incoming_group_trigger"
  );

  if (services.sessionManager.hasActiveResponse(context.session.id)) {
    services.sessionManager.appendSteerMessage(context.session.id, context.enrichedMessage);
    // Abort queued outbound messages that haven't been sent yet.
    // Already-sent messages are unaffected; generation and tool execution continue.
    const interrupted = services.sessionManager.interruptOutbound(context.session.id);
    // Also add to pending so the message triggers a new generation cycle
    // after the current one finishes (even if steer was consumed by the model,
    // the response text was discarded due to the outbound abort).
    services.sessionManager.appendPendingMessage(context.session.id, context.enrichedMessage);
    persistSession(context.session.id, "user_message_steered_and_outbound_interrupted");
    logger.info({ sessionId: context.session.id, interrupted }, "user_message_steered_and_outbound_interrupted");
    return;
  }

  services.sessionManager.appendPendingMessage(context.session.id, context.enrichedMessage);
  persistSession(context.session.id, "user_message_received");
  services.debounceManager.schedule(context.session.id, () => {
    flushSession(context.session.id);
  });
}
