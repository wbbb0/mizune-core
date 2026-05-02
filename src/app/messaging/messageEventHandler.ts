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
    contentSafetyService,
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
      scenarioProfileStore: services.scenarioProfileStore
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

  if (contentSafetyService) {
    const moderation = await contentSafetyService.moderateIncomingMessage({
      message: context.enrichedMessage,
      sessionId: context.session.id,
      delivery: deps.inboundDelivery
    });
    if (moderation.events.length > 0) {
      logger.warn({
        sessionId: context.session.id,
        eventCount: moderation.events.length,
        events: moderation.events.map((event) => ({
          subjectKind: event.subjectKind,
          decision: event.decision,
          auditKey: event.auditKey,
          fileId: event.fileId,
          contentHash: event.contentHash,
          reason: event.reason
        }))
      }, "incoming_message_content_safety_projected");
      context = {
        ...context,
        enrichedMessage: moderation.projectedMessage,
        contentSafetyEvents: moderation.events
      };
    }
  }

  const triggerDecision = deps.inboundDelivery === "web"
    ? {
        groupMatched: false,
        matchedPendingGroupTrigger: false,
        shouldTriggerResponse: true,
        threadAction: "reply_now" as const,
        replyDecision: "reply_small" as const,
        interruptPolicy: "soft_interrupt" as const,
        contextPolicy: "new_thread" as const,
        priority: "normal" as const,
        reason: "Web 输入默认回复"
      }
    : await resolveTriggerDecision(
        { config, whitelistStore, conversationAccess, sessionManager },
        context
      );

  let activeResponseAlreadyInterrupted = false;
  if (
    triggerDecision.shouldTriggerResponse
    && sessionManager.hasActiveResponse(context.session.id)
    && (triggerDecision.interruptPolicy === "soft_interrupt" || triggerDecision.interruptPolicy === "abort_generation")
  ) {
    const interrupted = sessionManager.interruptResponse(context.session.id);
    activeResponseAlreadyInterrupted = true;
    logger.info({ sessionId: context.session.id, interrupted }, "user_message_interrupted_active_response");
  }

  appendIncomingHistory(sessionManager, logger, context, isAmbientOnlyDecision(triggerDecision)
    ? {
        runtimeVisibility: "ambient",
        transcriptGroup: "standalone"
      }
    : undefined);

  if (triggerDecision.threadAction === "wait_more") {
    sessionManager.appendPendingMessage(context.session.id, context.enrichedMessage);
    persistSession(context.session.id, "group_message_wait_more");
    if (!sessionManager.hasActiveResponse(context.session.id)) {
      debounceManager.schedule(context.session.id, () => {
        flushSession(context.session.id);
      }, {
        reason: "gate_wait",
        multiplierOverride: config.conversation.debounce.plannerWaitMultiplier
      });
    }
    logReceivedMessage(logger, context, triggerDecision);
    return;
  }

  if (triggerDecision.threadAction === "queue_next_thread") {
    sessionManager.appendPendingMessage(context.session.id, context.enrichedMessage);
    persistSession(context.session.id, "group_message_queued_next_thread");
    if (!sessionManager.hasActiveResponse(context.session.id)) {
      debounceManager.schedule(context.session.id, () => {
        flushSession(context.session.id);
      });
    }
    logReceivedMessage(logger, context, triggerDecision);
    return;
  }

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

function isAmbientOnlyDecision(input: { threadAction: string }): boolean {
  return input.threadAction === "ambient_only" || input.threadAction === "drop_due_cooldown";
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
