import type { Logger } from "pino";
import { parseDirectCommand, resolveDispatchableDirectCommand } from "./directCommands.ts";
import { resolvePostRouterSetupDecision, resolvePreRouterSetupDecision } from "./messageAdmission.ts";
import { extractFileSources, extractText } from "#services/onebot/messageSegments.ts";
import type { Relationship } from "#identity/relationship.ts";
import type { AppServiceBootstrap } from "../bootstrap/appServiceBootstrap.ts";
import type { OneBotMessageEvent, ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionManager.ts";
import type { SessionDelivery } from "#conversation/session/sessionTypes.ts";

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

export interface MessageEventHandlerDeps {
  inboundDelivery: SessionDelivery;
  services: Pick<
    AppServiceBootstrap,
    | "config"
    | "logger"
    | "whitelistStore"
    | "router"
    | "oneBotClient"
    | "sessionManager"
    | "debounceManager"
    | "audioStore"
    | "mediaWorkspace"
    | "mediaCaptionService"
    | "requestStore"
    | "userStore"
    | "setupStore"
    | "conversationAccess"
  >;
  handleDirectCommand: (input: {
    command: ReturnType<typeof parseDirectCommand> extends infer T ? Exclude<T, null> : never;
    sessionId: string;
    incomingMessage: {
      chatType: "private" | "group";
      userId: string;
      groupId?: string;
      relationship?: Relationship;
    };
  }) => Promise<void>;
  persistSession: (sessionId: string, reason: string) => void;
  sendImmediateText: (params: {
    sessionId: string;
    userId: string;
    groupId?: string;
    text: string;
    recordInHistory?: boolean;
    transcriptItem?: InternalTranscriptItem;
    recordForRetract?: boolean;
    autoRetractAfterMs?: number;
  }) => Promise<void>;
  flushSession: (sessionId: string, options?: {
    skipReplyGate?: boolean;
    delivery?: "onebot" | "web";
    webOutputCollector?: {
      append: (chunk: string) => Promise<void> | void;
    };
  }) => void;
}

export type MessageHandlerServices = MessageEventHandlerDeps["services"];
export type MessageSendImmediateText = MessageEventHandlerDeps["sendImmediateText"];
export type MessageFlushSession = MessageEventHandlerDeps["flushSession"];

type DirectCommandInput = Parameters<MessageEventHandlerDeps["handleDirectCommand"]>[0];

type EnrichedIncomingMessage = ParsedIncomingMessage & {
  audioIds: string[];
  imageIds: string[];
  emojiIds: string[];
};

interface MessageProcessingContext {
  setupState: Awaited<ReturnType<MessageHandlerServices["setupStore"]["get"]>>;
  user: Awaited<ReturnType<MessageHandlerServices["userStore"]["touchSeenUser"]>>;
  enrichedMessage: EnrichedIncomingMessage;
  session: ReturnType<MessageHandlerServices["sessionManager"]["getOrCreateSession"]>;
}

interface TriggerDecision {
  groupMatched: boolean;
  matchedPendingGroupTrigger: boolean;
  shouldTriggerResponse: boolean;
}

function resolveRawText(event: OneBotMessageEvent): string {
  return extractText(event.message).trim() || event.raw_message.trim();
}

async function handlePreRouterDecision(
  services: Pick<MessageHandlerServices, "logger" | "oneBotClient">,
  handleDirectCommand: MessageEventHandlerDeps["handleDirectCommand"],
  decision: ReturnType<typeof resolvePreRouterSetupDecision>
): Promise<boolean> {
  if (decision.kind === "handle_bootstrap_command") {
    services.logger.info(
      { sessionId: decision.sessionId, command: decision.command.name },
      "direct_command_received"
    );
    await handleDirectCommand(decision);
    return true;
  }

  if (decision.kind === "reject_private_before_owner_bound") {
    await services.oneBotClient.sendText({
      userId: decision.userId,
      text: decision.text
    });
    return true;
  }

  return false;
}

function logIgnoredMessage(
  logger: Logger,
  event: OneBotMessageEvent
): void {
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

async function createMessageProcessingContext(
  services: Pick<
    MessageHandlerServices,
    "audioStore" | "mediaWorkspace" | "sessionManager" | "userStore" | "setupStore"
  >,
  incomingMessage: ParsedIncomingMessage,
  options?: {
    targetSessionId?: string;
  }
): Promise<MessageProcessingContext> {
  const fileSources = incomingMessage.rawEvent
    ? extractFileSources(incomingMessage.rawEvent.message)
    : [];
  const [setupState, user, registeredAudios, importedImageAssets, importedFileAssets] = await Promise.all([
    services.setupStore.get(),
    services.userStore.touchSeenUser({
      userId: incomingMessage.userId,
      nickname: incomingMessage.senderName
    }),
    services.audioStore.registerSources(incomingMessage.audioSources),
    Promise.all(
      incomingMessage.images
        .map(async (source) => services.mediaWorkspace.importRemoteSource({
          source,
          kind: "image",
          origin: "chat_message",
          sourceContext: {
            mediaKind: incomingMessage.emojiSources.includes(source) ? "emoji" : "image",
            userId: incomingMessage.userId,
            senderName: incomingMessage.senderName
          }
        }).catch(() => null))
    ),
    Promise.all(
      fileSources.map(async (fileSource) => services.mediaWorkspace.importRemoteSource({
        source: fileSource.source,
        kind: "file",
        origin: "chat_message",
        ...(fileSource.filename ? { sourceName: fileSource.filename } : {}),
        ...(fileSource.mimeType ? { mimeType: fileSource.mimeType } : {}),
        sourceContext: {
          userId: incomingMessage.userId,
          senderName: incomingMessage.senderName
        }
      }).catch(() => null))
    )
  ]);

  const enrichedMessage: EnrichedIncomingMessage = {
    ...incomingMessage,
    audioIds: registeredAudios.map((item: { id: string }) => item.id),
    imageIds: importedImageAssets
      .filter((item): item is NonNullable<typeof item> => item != null)
      .filter((item) => item.sourceContext.mediaKind !== "emoji")
      .map((item) => item.fileId),
    emojiIds: importedImageAssets
      .filter((item): item is NonNullable<typeof item> => item != null)
      .filter((item) => item.sourceContext.mediaKind === "emoji")
      .map((item) => item.fileId),
    attachments: [
      ...importedImageAssets
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .map((item) => ({
          fileId: item.fileId,
          kind: item.kind,
          source: "chat_message" as const,
          sourceName: item.sourceName,
          mimeType: item.mimeType,
          semanticKind: item.sourceContext.mediaKind === "emoji" ? "emoji" : "image"
        })),
      ...importedFileAssets
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .map((item) => ({
          fileId: item.fileId,
          kind: item.kind,
          source: "chat_message" as const,
          sourceName: item.sourceName,
          mimeType: item.mimeType
        }))
    ]
  };

  return {
    setupState,
    user,
    enrichedMessage,
    session: options?.targetSessionId
      ? resolveTargetSession(services.sessionManager, incomingMessage, options.targetSessionId)
      : services.sessionManager.getOrCreateSession(enrichedMessage)
  };
}

function resolveTargetSession(
  sessionManager: Pick<MessageHandlerServices, "sessionManager">["sessionManager"],
  incomingMessage: ParsedIncomingMessage,
  targetSessionId: string
) {
  const session = sessionManager.getSession(targetSessionId);
  if (session.type !== incomingMessage.chatType) {
    throw new Error(`Session type mismatch for ${targetSessionId}`);
  }
  return session;
}

async function handlePostRouterSetupDecision(
  services: Pick<MessageHandlerServices, "logger" | "whitelistStore">,
  context: MessageProcessingContext,
  sendImmediateText: MessageEventHandlerDeps["sendImmediateText"]
): Promise<boolean> {
  const ownerId = services.whitelistStore.getOwnerId();
  const decision = resolvePostRouterSetupDecision({
    setupState: context.setupState.state,
    chatType: context.enrichedMessage.chatType,
    relationship: context.user.relationship,
    ...(ownerId ? { ownerId } : {})
  });

  if (decision.kind === "allow") {
    return false;
  }

  if (decision.kind === "ignore_during_setup") {
    services.logger.info(
      {
        sessionId: context.session.id,
        chatType: context.enrichedMessage.chatType,
        userId: context.enrichedMessage.userId,
        groupId: context.enrichedMessage.groupId,
        relationship: context.user.relationship
      },
      "message_ignored_during_setup"
    );
    return true;
  }

  await sendImmediateText({
    sessionId: context.session.id,
    userId: context.enrichedMessage.userId,
    text: decision.text,
    recordInHistory: false,
    transcriptItem: {
      kind: "status_message",
      llmVisible: false,
      role: "assistant",
      statusType: "system",
      content: decision.text,
      timestampMs: Date.now()
    },
    recordForRetract: false
  });
  services.logger.info(
    {
      sessionId: context.session.id,
      userId: context.enrichedMessage.userId,
      relationship: context.user.relationship,
      setupState: context.setupState.state
    },
    "private_message_blocked_during_setup"
  );
  return true;
}

async function resolveTriggerDecision(
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

function resolveChatDirectCommand(
  context: MessageProcessingContext
): DirectCommandInput["command"] | null {
  return resolveDispatchableDirectCommand({
    phase: "chat",
    setupState: context.setupState.state,
    chatType: context.enrichedMessage.chatType,
    relationship: context.user.relationship,
    isAtMentioned: context.enrichedMessage.isAtMentioned,
    text: context.enrichedMessage.text,
    hasImages: context.enrichedMessage.images.length > 0,
    hasForwards: context.enrichedMessage.forwardIds.length > 0,
    hasAudio: context.enrichedMessage.audioSources.length > 0
  });
}

async function dispatchChatDirectCommand(
  logger: Logger,
  sessionManager: MessageHandlerServices["sessionManager"],
  persistSession: MessageEventHandlerDeps["persistSession"],
  handleDirectCommand: MessageEventHandlerDeps["handleDirectCommand"],
  context: MessageProcessingContext,
  command: DirectCommandInput["command"]
): Promise<void> {
  logger.info({ sessionId: context.session.id, command: command.name }, "direct_command_received");
  sessionManager.appendInternalTranscript(context.session.id, {
    kind: "direct_command",
    llmVisible: false,
    direction: "input",
    role: "user",
    commandName: command.name,
    content: context.enrichedMessage.text,
    timestampMs: Date.now()
  });
  persistSession(context.session.id, "direct_command_input_recorded");
  await handleDirectCommand({
    command,
    sessionId: context.session.id,
    incomingMessage: {
      chatType: context.enrichedMessage.chatType,
      userId: context.enrichedMessage.userId,
      ...(context.enrichedMessage.groupId ? { groupId: context.enrichedMessage.groupId } : {}),
      relationship: context.user.relationship
    }
  });
}

function appendIncomingHistory(
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

function handleNonTriggeringMessage(
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

function enqueueTriggeredMessage(
  services: Pick<
    MessageHandlerServices,
    "sessionManager" | "debounceManager" | "mediaCaptionService"
  >,
  inboundDelivery: SessionDelivery,
  context: MessageProcessingContext,
  triggerDecision: TriggerDecision,
  persistSession: MessageEventHandlerDeps["persistSession"],
  flushSession: MessageEventHandlerDeps["flushSession"],
  logger: Logger
): void {
  if (shouldUpdateSessionReplyDelivery(inboundDelivery, context.enrichedMessage)) {
    services.sessionManager.setLastInboundDelivery(context.session.id, inboundDelivery);
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

function logReceivedMessage(
  logger: Logger,
  context: MessageProcessingContext,
  triggerDecision: TriggerDecision
): void {
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
      forwardCount: context.enrichedMessage.forwardIds.length,
      replyMessageId: context.enrichedMessage.replyMessageId,
      mentionUserCount: context.enrichedMessage.mentionUserIds.length,
      mentionedAll: context.enrichedMessage.mentionedAll,
      relationship: context.user.relationship
    },
    "message_received"
  );
}

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
    sessionManager,
    debounceManager,
    audioStore,
    mediaWorkspace,
    mediaCaptionService,
    userStore,
    setupStore,
    conversationAccess
  } = services;

  const context = await createMessageProcessingContext(
    { audioStore, mediaWorkspace, sessionManager, userStore, setupStore },
    incomingMessage,
    options
  );

  if (deps.inboundDelivery === "onebot" && await handlePostRouterSetupDecision({ logger, whitelistStore }, context, sendImmediateText)) {
    return;
  }

  const triggerDecision = deps.inboundDelivery === "web"
    ? {
        groupMatched: false,
        matchedPendingGroupTrigger: false,
        shouldTriggerResponse: true
      }
    : await resolveTriggerDecision(
        { config, whitelistStore, conversationAccess, sessionManager },
        context
      );
  const command = resolveChatDirectCommand(context);
  if (command) {
    try {
      await dispatchChatDirectCommand(logger, sessionManager, persistSession, handleDirectCommand, context, command);
    } catch (error: unknown) {
      logger.error({ error, sessionId: context.session.id, command: command.name }, "direct_command_failed");
      throw error;
    }
    return;
  }

  appendIncomingHistory(sessionManager, logger, context);
  if (handleNonTriggeringMessage(logger, persistSession, context, triggerDecision)) {
    return;
  }

  enqueueTriggeredMessage(
    { sessionManager, mediaCaptionService, debounceManager },
    deps.inboundDelivery,
    context,
    triggerDecision,
    persistSession,
    flushSession,
    logger
  );
  logReceivedMessage(logger, context, triggerDecision);
}

// Handles incoming OneBot message events and routes them into session work.
export function createMessageEventHandler(deps: MessageEventHandlerDeps) {
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
    router,
    oneBotClient,
    sessionManager,
    debounceManager,
    audioStore,
    userStore,
    setupStore,
    conversationAccess
  } = services;

  return async (event: OneBotMessageEvent): Promise<void> => {
    const currentSetupState = await setupStore.get();
    const rawText = resolveRawText(event);
    const preRouterDecision = resolvePreRouterSetupDecision({
      setupState: currentSetupState.state,
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
