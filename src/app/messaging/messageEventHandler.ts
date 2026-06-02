import { resolvePreRouterSetupDecision } from "./messageAdmission.ts";
import type { OneBotMessageEvent, ParsedIncomingMessage } from "#services/onebot/types.ts";
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
  resolveIncomingOneBotSourceRef
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
    mediaCaptionService,
    userStore,
    setupStore,
    conversationAccess
  } = services;

  const sourceRef = resolveIncomingOneBotSourceRef(incomingMessage);
  if (sourceRef != null) {
    const sessionId = options?.targetSessionId ?? buildSessionId(incomingMessage);
    if (hasHistorySource(sessionManager, sessionId, sourceRef)) {
      logger.info(
        {
          sessionId,
          sourceRef
        },
        "incoming_message_duplicate_ignored"
      );
      return;
    }
  }

  let context = await createMessageProcessingContext(
    { audioStore, chatFileStore, sessionManager, userStore, setupStore, userIdentityStore },
    incomingMessage,
    {
      ...options,
      delivery: deps.inboundDelivery
    }
  );

  if (deps.inboundDelivery === "onebot" && await handlePostRouterSetupDecision({ logger, userIdentityStore }, context, sendImmediateText)) {
    return;
  }

  await ensureAutomaticSetupOperationMode(
    {
      sessionManager,
      globalProfileReadinessStore: services.globalProfileReadinessStore,
      personaStore: services.personaStore,
      rpProfileStore: services.rpProfileStore,
      scenarioHostStateStore: services.scenarioHostStateStore
    },
    context,
    persistSession
  );

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

  const triggerDecision = deps.inboundDelivery === "web"
    ? {
        groupMatched: false,
        userMatched: true,
        directlyAddressed: true,
        replyToBot: false,
        shouldTriggerResponse: true,
        threadAction: "reply_now" as const,
        replyDecision: "reply_small" as const,
        interruptPolicy: "soft_interrupt" as const,
        priority: "normal" as const,
        reason: "Web 输入默认回复"
      }
    : await resolveTriggerDecision(
        { config, whitelistStore, conversationAccess, sessionManager },
        context
      );
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
  sourceRef: NonNullable<ReturnType<typeof resolveIncomingOneBotSourceRef>>
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
