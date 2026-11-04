import { resolvePreRouterSetupDecision } from "./messageAdmission.ts";
import type { ParsedIncomingMessage } from "#services/messaging/incomingMessage.ts";
import type { OneBotMessageEvent } from "#services/onebot/types.ts";
import {
  type MessageEventHandlerDeps,
  type MessageFlushSession,
  type MessageHandlerServices,
  type MessageSendImmediateText
} from "./messageHandlerTypes.ts";
import { createMessageProcessingContext } from "./messageContextBuilder.ts";
import { dispatchChatDirectCommand, resolveChatDirectCommand } from "./messageCommandFlow.ts";
import {
  ensureAutomaticSetupOperationMode,
  handlePostRouterSetupDecision,
  handlePreRouterDecision,
  logDirectCommandFailed
} from "./messageSetupFlow.ts";
import {
  appendIncomingHistory,
  enqueueTriggeredMessage,
  handleNonTriggeringMessage,
  resolveTriggerDecision
} from "./messageTriggerFlow.ts";
import { logIgnoredMessage, logReceivedMessage, resolveRawText } from "./messageLogging.ts";
import {
  resolveIncomingSourceRef, canActivateRecordedGroupContext
} from "./incomingHistory.ts";
import { buildSessionId } from "#conversation/session/sessionIdentity.ts";

export type {
  MessageEventHandlerDeps,
  MessageFlushSession,
  MessageHandlerServices,
  MessageSendImmediateText
};

export async function processIncomingMessage(
  deps: MessageEventHandlerDeps,
  incomingMessage: ParsedIncomingMessage,
  options?: {
    targetSessionId?: string;
  }
): Promise<void> {
  const {
    services,
    handleDirectCommand,
    persistSession,
    sendImmediateText,
    flushSession
  } = deps;
  const {
    config,
    logger,
    whitelistStore,
    userIdentityStore,
    sessionManager,
    debounceManager,
    audioStore,
    chatFileStore,
    mediaImportService,
    oneBotReferenceResolver,
    mediaCaptionService,
    userStore,
    setupStore,
    conversationAccess
  } = services;

  const sourceRef = resolveIncomingSourceRef(incomingMessage);
  if (sourceRef != null) {
    const sessionId = options?.targetSessionId ?? buildSessionId(incomingMessage);
    if (hasHistorySource(sessionManager, sessionId, sourceRef)) {
      if (canActivateRecordedGroupContext(incomingMessage, sessionManager.getSession(sessionId).internalTranscript)) {
        incomingMessage = { ...incomingMessage, activationUpgrade: true };
      } else {
        logger.info(
          { sessionId, sourceRef },
          "incoming_message_duplicate_ignored"
        );
        return;
      }
    }
  }

  let context = await createMessageProcessingContext(
    { audioStore, chatFileStore, mediaImportService, oneBotReferenceResolver, sessionManager, userStore, setupStore, userIdentityStore },
    incomingMessage,
    {
      ...options,
      delivery: deps.inboundDelivery
    }
  );

  if (incomingMessage.contextOnly) {
    // Media is cached through the shared ingress pipeline. Passive context never executes commands, setup or model calls.
    const decision = {
      groupMatched: false, userMatched: false, directlyAddressed: context.enrichedMessage.isAtMentioned,
      shouldTriggerResponse: false, threadAction: "record_only" as const, replyDecision: "no_reply" as const,
      interruptPolicy: "none" as const, priority: "low" as const, reason: "仅保存收到的群上下文"
    };
    appendIncomingHistory(sessionManager, logger, context, { transcriptGroup: "standalone" });
    persistSession(context.session.id, "group_context_received");
    logReceivedMessage(logger, context, decision);
    return;
  }

  if (deps.inboundDelivery === "onebot" && await handlePostRouterSetupDecision({ logger, userIdentityStore }, context, sendImmediateText)) {
    return;
  }
  const command = resolveChatDirectCommand(context);
  if (command) {
    try {
      await dispatchChatDirectCommand(logger, sessionManager, persistSession, handleDirectCommand, context, command);
    } catch (error: unknown) {
      logDirectCommandFailed(logger, error, context.session.id, command.name);
      throw error;
    }
    return;
  }

  await ensureAutomaticSetupOperationMode(
    {
      config,
      sessionManager,
      globalProfileReadinessStore: services.globalProfileReadinessStore,
      personaStore: services.personaStore,
      rpProfileStore: services.rpProfileStore,
      scenarioHostStateStore: services.scenarioHostStateStore
    },
    context,
    persistSession
  );

  const initialTriggerDecision = deps.inboundDelivery === "web"
    ? {
        groupMatched: false,
        userMatched: true,
        directlyAddressed: true,
        shouldTriggerResponse: true,
        threadAction: "reply_now" as const,
        replyDecision: "reply_small" as const,
        interruptPolicy: "soft_interrupt" as const,
        priority: "normal" as const,
        reason: "已准入消息直接回复"
      }
    : await resolveTriggerDecision(
        { config, whitelistStore, conversationAccess, sessionManager },
        context
      );
  const triggerDecision = {
    ...initialTriggerDecision,
    interruptPolicy: initialTriggerDecision.interruptPolicy === "soft_interrupt"
      && config.conversation.interruptionMode === "after_tool"
      ? "steer" as const
      : initialTriggerDecision.interruptPolicy
  };
  const hasActiveResponseAtAdmission = sessionManager.hasActiveResponse(context.session.id);
  let activeResponseAlreadyInterrupted = false;
  if (
    triggerDecision.shouldTriggerResponse
    && hasActiveResponseAtAdmission
    && triggerDecision.interruptPolicy === "soft_interrupt"
  ) {
    const interrupted = sessionManager.interruptResponse(context.session.id);
    activeResponseAlreadyInterrupted = true;
    logger.info({ sessionId: context.session.id, interrupted }, "user_message_interrupted_active_response");
  }

  if (triggerDecision.threadAction === "queue_next_thread") {
    const queuedTarget = sessionManager.enqueueGroupReplyTarget(context.session.id, context.enrichedMessage);
    appendIncomingHistory(sessionManager, logger, context, { transcriptGroupId: queuedTarget.transcriptGroupId });
    persistSession(context.session.id, "group_message_queued_next_thread");
    if (!hasActiveResponseAtAdmission && sessionManager.getSession(context.session.id).pendingMessages.length === 0) {
      const promoted = sessionManager.promoteNextQueuedGroupReplyTarget(context.session.id);
      if (promoted > 0) {
        persistSession(context.session.id, "group_reply_target_promoted");
        debounceManager.schedule(context.session.id, () => {
          flushSession(context.session.id);
        });
      }
    }
    logReceivedMessage(logger, context, triggerDecision);
    return;
  }

  appendIncomingHistory(sessionManager, logger, context, !triggerDecision.shouldTriggerResponse
    ? { transcriptGroup: "standalone" }
    : undefined);

  if (handleNonTriggeringMessage(sessionManager, logger, persistSession, context, triggerDecision)) {
    return;
  }

  enqueueTriggeredMessage(
    { sessionManager, mediaCaptionService, debounceManager },
    deps.inboundDelivery,
    context,
    persistSession,
    flushSession,
    logger,
    {
      activeResponseAlreadyInterrupted,
      interruptPolicy: triggerDecision.interruptPolicy
    }
  );
  logReceivedMessage(logger, context, triggerDecision);
}

// Handles incoming OneBot message events and routes them into session work.
export function createMessageEventHandler(deps: MessageEventHandlerDeps) {
  const {
    services,
    handleDirectCommand
  } = deps;
  const {
    config,
    logger,
    router,
    oneBotClient,
    setupStore
  } = services;

  return async (event: OneBotMessageEvent): Promise<void> => {
    const currentSetupState = await setupStore.get();
    const rawText = resolveRawText(event);
    const preRouterDecision = resolvePreRouterSetupDecision({
      setupState: currentSetupState.state,
      channelId: config.configRuntime.instanceName,
      eventMessageType: event.message_type,
      eventUserId: String(event.user_id),
      selfId: String(event.self_id),
      rawText,
      segmentCount: event.message.length
    });

    if (await handlePreRouterDecision({ logger, oneBotClient }, handleDirectCommand, preRouterDecision)) {
      return;
    }

    const incomingMessage = router.toIncomingMessage(event);

    if (incomingMessage == null) {
      logIgnoredMessage(logger, event);
      return;
    }

    await processIncomingMessage(deps, incomingMessage);
  };
}

function hasHistorySource(
  sessionManager: MessageHandlerServices["sessionManager"],
  sessionId: string,
  sourceRef: NonNullable<ReturnType<typeof resolveIncomingSourceRef>>
): boolean {
  try {
    return sessionManager.hasHistorySource(sessionId, sourceRef);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("Session not found:")) {
      return false;
    }
    throw error;
  }
}
