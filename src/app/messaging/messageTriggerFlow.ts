import type { Logger } from "pino";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { SessionDelivery } from "#conversation/session/sessionTypes.ts";
import type { SessionState } from "#conversation/session/sessionTypes.ts";
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
  const userMatched = isWhitelistedUser(services.whitelistStore, context.enrichedMessage);
  const replyToBot = isReplyToBot(context.session, context.enrichedMessage.replyMessageId);

  if (context.enrichedMessage.chatType === "private") {
    const hasActiveResponse = services.sessionManager.hasActiveResponse(context.session.id);
    return {
      groupMatched: false,
      userMatched,
      directlyAddressed: true,
      replyToBot: false,
      shouldTriggerResponse: true,
      threadAction: hasActiveResponse ? "soft_interrupt" : "reply_now",
      replyDecision: "reply_small",
      interruptPolicy: hasActiveResponse ? "soft_interrupt" : "none",
      priority: context.user.relationship === "owner" ? "owner" : "normal",
      reason: hasActiveResponse ? "私聊新消息软打断当前回复" : "私聊消息默认回复"
    };
  }

  const directlyAddressed = context.enrichedMessage.isAtMentioned || replyToBot;
  const accessAllowed = context.user.relationship === "owner" || userMatched || groupMatched;
  if (!accessAllowed) {
    return buildNoReplyDecision({
      groupMatched,
      userMatched,
      directlyAddressed,
      replyToBot,
      reason: "群聊用户或群不在白名单，且不是 owner"
    });
  }
  if (!directlyAddressed) {
    return buildNoReplyDecision({
      groupMatched,
      userMatched,
      directlyAddressed,
      replyToBot,
      reason: "群聊未直接 @ bot 或回复 bot 消息"
    });
  }

  const currentTarget = resolveCurrentGroupReplyTarget(context.session);
  const hasActiveResponse = services.sessionManager.hasActiveResponse(context.session.id);
  if (!currentTarget && context.session.queuedGroupReplyTargets.length > 0) {
    return {
      groupMatched,
      userMatched,
      directlyAddressed,
      replyToBot,
      shouldTriggerResponse: true,
      threadAction: "queue_next_thread",
      replyDecision: "reply_small",
      interruptPolicy: "queue",
      priority: context.user.relationship === "owner" ? "owner" : "normal",
      reason: "群聊已有待回复队列，新的直接触发进入去重队列"
    };
  }
  if (currentTarget && currentTarget.userId !== context.enrichedMessage.userId) {
    return {
      groupMatched,
      userMatched,
      directlyAddressed,
      replyToBot,
      shouldTriggerResponse: true,
      threadAction: "queue_next_thread",
      replyDecision: "reply_small",
      interruptPolicy: "queue",
      priority: context.user.relationship === "owner" ? "owner" : "normal",
      reason: "群聊已有当前回复目标，其他用户直接触发进入去重队列"
    };
  }

  if (hasActiveResponse && currentTarget?.userId === context.enrichedMessage.userId) {
    return {
      groupMatched,
      userMatched,
      directlyAddressed,
      replyToBot,
      shouldTriggerResponse: true,
      threadAction: "soft_interrupt",
      replyDecision: "reply_small",
      interruptPolicy: "soft_interrupt",
      priority: context.user.relationship === "owner" ? "owner" : "normal",
      reason: "当前回复目标再次直接触发，软打断当前回复"
    };
  }

  return {
    groupMatched,
    userMatched,
    directlyAddressed,
    replyToBot,
    shouldTriggerResponse: true,
    threadAction: "reply_now",
    replyDecision: "reply_small",
    interruptPolicy: "none",
    priority: context.user.relationship === "owner" ? "owner" : "normal",
    reason: "群聊直接 @ bot 或回复 bot 消息"
  };
}

function isWhitelistedUser(
  whitelistStore: Pick<MessageHandlerServices["whitelistStore"], "hasUser">,
  message: Pick<MessageProcessingContext["enrichedMessage"], "userId" | "externalUserId">
): boolean {
  return whitelistStore.hasUser(message.userId)
    || (message.externalUserId != null && whitelistStore.hasUser(message.externalUserId));
}

function isReplyToBot(
  session: { sentMessages: Array<{ messageId: number }> },
  replyMessageId: string | null
): boolean {
  if (!replyMessageId) {
    return false;
  }
  const numericId = Number(replyMessageId);
  if (!Number.isSafeInteger(numericId)) {
    return false;
  }
  return session.sentMessages.some((item) => item.messageId === numericId);
}

function resolveCurrentGroupReplyTarget(session: SessionState): { userId: string } | null {
  if (session.currentReplyTarget?.chatType === "group") {
    return { userId: session.currentReplyTarget.userId };
  }
  const pending = session.pendingMessages[0];
  if (pending?.chatType === "group") {
    return { userId: pending.userId };
  }
  if (session.activeAssistantDraftResponse?.chatType === "group") {
    return { userId: session.activeAssistantDraftResponse.userId };
  }
  if (session.activeAssistantResponse?.chatType === "group") {
    return { userId: session.activeAssistantResponse.userId };
  }
  return null;
}

function buildNoReplyDecision(input: {
  groupMatched: boolean;
  userMatched: boolean;
  directlyAddressed: boolean;
  replyToBot: boolean;
  reason: string;
}): TriggerDecision {
  return {
    groupMatched: input.groupMatched,
    userMatched: input.userMatched,
    directlyAddressed: input.directlyAddressed,
    replyToBot: input.replyToBot,
    shouldTriggerResponse: false,
    threadAction: "record_only",
    replyDecision: "no_reply",
    interruptPolicy: "none",
    priority: "low",
    reason: input.reason
  };
}

export function appendIncomingHistory(
  sessionManager: MessageHandlerServices["sessionManager"],
  logger: Logger,
  context: MessageProcessingContext,
  options?: {
    transcriptGroup?: "pending" | "standalone";
    transcriptGroupId?: string;
  }
): void {
  const sourceRef = resolveIncomingOneBotSourceRef(context.enrichedMessage);
  appendIncomingHistoryTranscript(sessionManager, context, {
    timestampMs: Date.now(),
    ...(sourceRef ? { sourceRef } : {}),
    ...(options?.transcriptGroup ? { transcriptGroup: options.transcriptGroup } : {}),
    ...(options?.transcriptGroupId ? { transcriptGroupId: options.transcriptGroupId } : {})
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
  message: Pick<ParsedIncomingMessage, "chatType" | "isAtMentioned" | "replyMessageId">
): boolean {
  return inboundDelivery === "web" || message.chatType === "private" || message.isAtMentioned || message.replyMessageId != null;
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
    interruptPolicy?: TriggerDecision["interruptPolicy"];
  }
): void {
  if (shouldUpdateSessionReplyDelivery(inboundDelivery, context.enrichedMessage)) {
    services.sessionManager.setReplyDelivery(context.session.id, inboundDelivery);
  }

  services.mediaCaptionService.schedule(
    [
      ...collectVisualAttachmentFileIds(context.enrichedMessage.attachments, "image"),
      ...collectVisualAttachmentFileIds(context.enrichedMessage.attachments, "emoji")
    ],
    context.enrichedMessage.chatType === "private" ? "incoming_private_message" : "incoming_group_trigger"
  );

  const hasActiveResponse = services.sessionManager.hasActiveResponse(context.session.id);
  const shouldInterruptActiveResponse = options?.activeResponseAlreadyInterrupted
    || (
      hasActiveResponse
      && options?.interruptPolicy === "soft_interrupt"
    );

  if (shouldInterruptActiveResponse) {
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

  if (hasActiveResponse) {
    services.sessionManager.appendPendingMessage(context.session.id, context.enrichedMessage);
    persistSession(context.session.id, "user_message_queued_during_active_response");
    logger.info({
      sessionId: context.session.id,
      chatType: context.enrichedMessage.chatType,
      userId: context.enrichedMessage.userId,
      interruptPolicy: options?.interruptPolicy ?? "none"
    }, "user_message_queued_during_active_response");
    return;
  }

  services.sessionManager.appendPendingMessage(context.session.id, context.enrichedMessage);
  persistSession(context.session.id, "user_message_received");
  services.debounceManager.schedule(context.session.id, () => {
    flushSession(context.session.id);
  });
}
