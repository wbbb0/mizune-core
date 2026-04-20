import { createDirectCommandHandler } from "../messaging/directCommands.ts";
import type {
  SessionDirectCommandAccess,
  SessionMessagingAccess
} from "#conversation/session/sessionCapabilities.ts";
import {
  createMessageEventHandler,
  processIncomingMessage,
  type MessageEventHandlerDeps,
  type MessageFlushSession,
  type MessageHandlerServices,
  type MessageSendImmediateText
} from "../messaging/messageEventHandler.ts";
import type { AppServiceBootstrap } from "../bootstrap/appServiceBootstrap.ts";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { GenerationWebOutputCollector } from "../generation/generationTypes.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";

type DirectCommandDeps = Pick<
  AppServiceBootstrap,
  | "config"
  | "oneBotClient"
  | "logger"
  | "historyCompressor"
  | "setupStore"
  | "scenarioHostStateStore"
  | "sessionCaptioner"
  | "userIdentityStore"
> & {
  sessionManager: SessionDirectCommandAccess & Pick<SessionMessagingAccess, "appendAssistantHistory" | "appendInternalTranscript">;
  persistSession: (sessionId: string, reason: string) => void;
  assignOwner: (input: {
    channelId: string;
    requesterUserId: string;
    targetUserId: string;
    sessionId: string;
    chatType: "private" | "group";
  }) => Promise<string>;
  flushSession: MessageFlushSession;
  onebotSendImmediateText: MessageSendImmediateText;
};

type DeliveryContext =
  | {
      kind: "onebot";
    }
  | {
      kind: "web";
      collector: GenerationWebOutputCollector;
      sessionId?: string;
    };

export function createRuntimeMessageIngress(input: {
  services: Omit<MessageHandlerServices, "sessionManager"> & {
    sessionManager: SessionMessagingAccess;
  };
  directCommandDeps: DirectCommandDeps;
  persistSession: (sessionId: string, reason: string) => void;
}) {
  const onebotHandleDirectCommand = createDeliveryHandleDirectCommand(input.directCommandDeps, { kind: "onebot" });
  const onebotDeps = buildMessageHandlerDeps(input.services, input.directCommandDeps, input.persistSession, {
    kind: "onebot",
    handleDirectCommand: onebotHandleDirectCommand
  });

  return {
    handleMessageEvent: createMessageEventHandler(onebotDeps),
    async handleIncomingMessage(incomingMessage: ParsedIncomingMessage, delivery: DeliveryContext = { kind: "onebot" }) {
      const deps = delivery.kind === "onebot"
        ? onebotDeps
        : buildMessageHandlerDeps(input.services, input.directCommandDeps, input.persistSession, {
            kind: "web",
            collector: delivery.collector,
            ...(delivery.sessionId ? { sessionId: delivery.sessionId } : {}),
            handleDirectCommand: createDeliveryHandleDirectCommand(input.directCommandDeps, delivery)
          });
      await processIncomingMessage(
        deps,
        incomingMessage,
        delivery.kind === "web" && delivery.sessionId
          ? { targetSessionId: delivery.sessionId }
          : undefined
      );
    }
  };
}

function buildMessageHandlerDeps(
  services: MessageHandlerServices,
  directCommandDeps: DirectCommandDeps,
  persistSession: (sessionId: string, reason: string) => void,
  input: DeliveryContext & {
    handleDirectCommand: MessageEventHandlerDeps["handleDirectCommand"];
  }
): MessageEventHandlerDeps {
  return {
    inboundDelivery: input.kind,
    services,
    handleDirectCommand: input.handleDirectCommand,
    persistSession,
    sendImmediateText: createDeliverySendImmediateText(
      directCommandDeps.onebotSendImmediateText,
      services,
      persistSession,
      input
    ),
    flushSession: createDeliveryFlushSession(directCommandDeps.flushSession, input)
  };
}

function createDeliveryHandleDirectCommand(
  deps: DirectCommandDeps,
  delivery: DeliveryContext
): MessageEventHandlerDeps["handleDirectCommand"] {
  return createDirectCommandHandler({
    config: deps.config,
    sessionManager: deps.sessionManager,
    oneBotClient: deps.oneBotClient,
    logger: deps.logger,
    sessionCaptioner: deps.sessionCaptioner,
    scenarioHostStateStore: deps.scenarioHostStateStore,
    forceCompactSession: async (sessionId, retainMessageCount) => (
      deps.historyCompressor.forceCompact(sessionId, retainMessageCount)
    ),
    flushSession: createDeliveryFlushSession(deps.flushSession, delivery),
    persistSession: deps.persistSession,
    sendImmediateText: createDeliverySendImmediateText(
      deps.onebotSendImmediateText,
      {
        sessionManager: deps.sessionManager
      },
      deps.persistSession,
      delivery
    ),
    isOwnerAssignmentAvailable: async () => (await deps.setupStore.get()).state !== "ready" && !deps.userIdentityStore.hasOwnerIdentitySync(),
    assignOwner: async ({ channelId, requesterUserId, targetUserId, sessionId, chatType }) => deps.assignOwner({
      channelId,
      requesterUserId,
      targetUserId,
      sessionId,
      chatType
    })
  });
}

function createDeliverySendImmediateText(
  onebotSendImmediateText: MessageSendImmediateText,
  services: {
    sessionManager: Pick<SessionMessagingAccess, "appendAssistantHistory" | "appendInternalTranscript">;
  },
  persistSession: (sessionId: string, reason: string) => void,
  delivery: DeliveryContext
): MessageSendImmediateText {
  if (delivery.kind === "onebot") {
    return onebotSendImmediateText;
  }

  return async (params) => {
    const timestampMs = Date.now();
    if (params.recordInHistory ?? true) {
      services.sessionManager.appendAssistantHistory(params.sessionId, {
        chatType: params.groupId ? "group" : "private",
        userId: params.userId,
        senderName: params.userId,
        text: params.text
      }, timestampMs);
    } else {
      services.sessionManager.appendInternalTranscript(params.sessionId, params.transcriptItem ?? {
        kind: "status_message",
        llmVisible: false,
        role: "assistant",
        statusType: "system",
        content: params.text,
        timestampMs
      } satisfies InternalTranscriptItem);
    }
    persistSession(params.sessionId, "web_immediate_text_recorded");
  };
}

function createDeliveryFlushSession(
  flushSession: MessageFlushSession,
  delivery: DeliveryContext
): MessageFlushSession {
  if (delivery.kind === "onebot") {
    return flushSession;
  }

  return (sessionId, options) => {
    flushSession(sessionId, {
      ...options,
      delivery: "web",
      webOutputCollector: delivery.collector
    });
  };
}
