import type { OwnerBootstrapRequest, OwnerBootstrapTransport } from "../bootstrap/ownerBootstrap.ts";
import { oneBotOwnerBootstrapTransport, officialOwnerBootstrapTransport } from "./ownerBootstrapTransport.ts";
import { buildSessionId } from "#conversation/session/sessionIdentity.ts";
import type { MessageReplyContext } from "#services/messaging/incomingMessage.ts";
import type { DeliveryCoordinator } from "#services/messaging/deliveryCoordinator.ts";
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
import type { ParsedIncomingMessage } from "#services/messaging/incomingMessage.ts";
import type {
  GenerationCommittedTextSink,
  GenerationDraftOverlaySink
} from "../generation/generationOutputContracts.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";

type DirectCommandDeps = Pick<
  AppServiceBootstrap,
  | "config"
  | "oneBotClient"
  | "qqOfficialClient"
  | "logger"
  | "historyCompressor"
  | "setupStore"
  | "personaStore"
  | "rpProfileStore"
  | "globalProfileReadinessStore"
  | "scenarioHostStateStore"
  | "statefulRpStateStore"
  | "sessionCaptioner"
  | "contextStore"
  | "userIdentityStore"
  | "recentErrorStore"
  | "stickerService"
> & {
  chatFileStore?: import("../../character/writes.ts").CharacterAssetStore;
  sessionManager: SessionDirectCommandAccess & Pick<SessionMessagingAccess, "appendAssistantHistory" | "appendInternalTranscript">;
  persistSession: (sessionId: string, reason: string) => void;
  assignOwner: (input: OwnerBootstrapRequest, transport: OwnerBootstrapTransport) => Promise<string>;
  isOwnerAssignmentAvailable: () => Promise<boolean>;
  flushSession: MessageFlushSession;
  onebotSendImmediateText: MessageSendImmediateText;
  messaging: DeliveryCoordinator;
};

type DeliveryContext =
  | {
      kind: "onebot";
    }
  | {
      kind: "qq_official";
      replyContext?: MessageReplyContext;
    }
  | {
      kind: "web";
      committedTextSink: GenerationCommittedTextSink;
      draftOverlaySink?: GenerationDraftOverlaySink;
      sessionId?: string;
    };

export function createRuntimeMessageIngress(input: {
  services: Omit<MessageHandlerServices, "sessionManager"> & {
    sessionManager: SessionMessagingAccess & import("#conversation/session/sessionCapabilities.ts").SessionOperationModeAccess;
  };
  directCommandDeps: DirectCommandDeps;
  persistSession: (sessionId: string, reason: string) => void;
}) {
  const onebotHandleDirectCommand = createDeliveryHandleDirectCommand(input.directCommandDeps, { kind: "onebot" });
  const onebotDeps = buildMessageHandlerDeps(input.services, input.directCommandDeps, input.persistSession, {
    kind: "onebot",
    handleDirectCommand: onebotHandleDirectCommand
  });

  const officialIngressQueues = new Map<string, Promise<void>>();

  return {
    handleMessageEvent: createMessageEventHandler(onebotDeps),
    async handleIncomingMessage(incomingMessage: ParsedIncomingMessage, delivery: DeliveryContext = { kind: "onebot" }) {
      const deps = delivery.kind === "onebot"
        ? onebotDeps
        : buildMessageHandlerDeps(input.services, input.directCommandDeps, input.persistSession, {
            ...delivery,
            handleDirectCommand: createDeliveryHandleDirectCommand(input.directCommandDeps, delivery)
          });
      const process = () => processIncomingMessage(
        deps, incomingMessage,
        delivery.kind === "web" && delivery.sessionId ? { targetSessionId: delivery.sessionId } : undefined
      );
      if (delivery.kind !== "qq_official") return process();
      // Earlier passive context must be stored before a later @ starts preparing its reply.
      const key = buildSessionId(incomingMessage);
      const previous = officialIngressQueues.get(key) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(process).finally(() => {
        if (officialIngressQueues.get(key) === next) officialIngressQueues.delete(key);
      });
      officialIngressQueues.set(key, next);
      return next;
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
  const handler = createDirectCommandHandler({
    config: deps.config,
    ...(deps.chatFileStore ? { chatFileStore: deps.chatFileStore } : {}),
    stickerService: deps.stickerService,
    sessionManager: deps.sessionManager,
    oneBotClient: deps.oneBotClient,
    messaging: deps.messaging,
    logger: deps.logger,
    sessionCaptioner: deps.sessionCaptioner,
    scenarioHostStateStore: deps.scenarioHostStateStore,
    statefulRpStateStore: deps.statefulRpStateStore,
    personaStore: deps.personaStore,
    rpProfileStore: deps.rpProfileStore,
    globalProfileReadinessStore: deps.globalProfileReadinessStore,
    setupStore: deps.setupStore,
    contextStore: deps.contextStore,
    recentErrorStore: deps.recentErrorStore,
    forceCompactSession: async (sessionId, retainMessageCount) => (
      deps.historyCompressor.forceCompact(sessionId, retainMessageCount)
    ),
    flushSession: createDeliveryFlushSession(deps.flushSession, delivery),
    persistSession: deps.persistSession,
    sendImmediateText: createDeliverySendImmediateText(
      deps.onebotSendImmediateText,
      {
        sessionManager: deps.sessionManager,
        messaging: deps.messaging
      },
      deps.persistSession,
      delivery
    ),
    isOwnerAssignmentAvailable: deps.isOwnerAssignmentAvailable,
    assignOwner: async (request) => {
      if (delivery.kind === "web") return "请在机器人私聊中使用 `.own`，或通过 WebUI 身份管理绑定账号。";
      const transport = delivery.kind === "onebot" ? oneBotOwnerBootstrapTransport(deps.oneBotClient) : officialOwnerBootstrapTransport({
        client: deps.qqOfficialClient, replyContext: delivery.replyContext, messaging: deps.messaging, sessionId: request.sessionId
      });
      return deps.assignOwner(request, transport);
    }
  });
  return handler;
}

function createDeliverySendImmediateText(
  onebotSendImmediateText: MessageSendImmediateText,
  services: {
    sessionManager: Pick<SessionMessagingAccess, "appendAssistantHistory" | "appendInternalTranscript">;
    messaging?: DeliveryCoordinator;
  },
  persistSession: (sessionId: string, reason: string) => void,
  delivery: DeliveryContext
): MessageSendImmediateText {
  if (delivery.kind === "onebot") {
    return onebotSendImmediateText;
  }

  return async (params) => {
    const deliveryRef = delivery.kind === "qq_official"
      ? await services.messaging!.sendText({ sessionId: params.sessionId, replyContext: delivery.replyContext }, params.text)
      : undefined;
    const timestampMs = Date.now();
    if (params.recordInHistory ?? true) {
      services.sessionManager.appendAssistantHistory(params.sessionId, {
        chatType: params.groupId ? "group" : "private",
        userId: params.userId,
        senderName: params.userId,
        text: params.text,
        ...(deliveryRef ? { deliveryRef } : {})
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
  if (delivery.kind !== "web") {
    return (sessionId, options) => flushSession(sessionId, { ...options, delivery: delivery.kind });
  }

  return (sessionId, options) => {
    flushSession(sessionId, {
      ...options,
      delivery: "web",
      committedTextSink: delivery.committedTextSink,
      ...(delivery.draftOverlaySink ? { draftOverlaySink: delivery.draftOverlaySink } : {})
    });
  };
}
