import type { Relationship } from "#identity/relationship.ts";
import type { AppServiceBootstrap } from "../bootstrap/appServiceBootstrap.ts";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionManager.ts";
import type { SessionDelivery } from "#conversation/session/sessionTypes.ts";
import type { parseDirectCommand } from "./directCommands.ts";

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

export type DirectCommandInput = Parameters<MessageEventHandlerDeps["handleDirectCommand"]>[0];

export type EnrichedIncomingMessage = ParsedIncomingMessage & {
  audioIds: string[];
  imageIds: string[];
  emojiIds: string[];
};

export interface MessageProcessingContext {
  setupState: Awaited<ReturnType<MessageHandlerServices["setupStore"]["get"]>>;
  user: Awaited<ReturnType<MessageHandlerServices["userStore"]["touchSeenUser"]>>;
  enrichedMessage: EnrichedIncomingMessage;
  session: ReturnType<MessageHandlerServices["sessionManager"]["getOrCreateSession"]>;
}

export interface TriggerDecision {
  groupMatched: boolean;
  matchedPendingGroupTrigger: boolean;
  shouldTriggerResponse: boolean;
}
