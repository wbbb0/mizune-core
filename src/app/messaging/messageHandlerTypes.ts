import type { Relationship } from "#identity/relationship.ts";
import type { AppServiceBootstrap } from "../bootstrap/appServiceBootstrap.ts";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { SessionMessagingAccess } from "#conversation/session/sessionCapabilities.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { SessionDelivery, SessionState } from "#conversation/session/sessionTypes.ts";
import type { parseDirectCommand } from "./directCommands.ts";

export interface MessageEventHandlerDeps {
  inboundDelivery: SessionDelivery;
  services: Omit<Pick<
    AppServiceBootstrap,
    | "config"
    | "logger"
    | "whitelistStore"
    | "userIdentityStore"
    | "router"
    | "oneBotClient"
    | "sessionManager"
    | "debounceManager"
    | "audioStore"
    | "chatFileStore"
    | "mediaCaptionService"
    | "requestStore"
    | "userStore"
    | "setupStore"
    | "conversationAccess"
  >, "sessionManager"> & {
    sessionManager: SessionMessagingAccess;
  };
  handleDirectCommand: (input: {
    command: ReturnType<typeof parseDirectCommand> extends infer T ? Exclude<T, null> : never;
    sessionId: string;
    incomingMessage: {
      channelId?: string;
      chatType: "private" | "group";
      userId: string;
      externalUserId?: string;
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
  channelId?: string;
  externalUserId?: string;
  audioIds: string[];
  imageIds: string[];
  emojiIds: string[];
};

export interface MessageProcessingContext {
  setupState: Awaited<ReturnType<MessageHandlerServices["setupStore"]["get"]>>;
  user: Awaited<ReturnType<MessageHandlerServices["userStore"]["touchSeenUser"]>>;
  enrichedMessage: EnrichedIncomingMessage;
  session: SessionState;
}

export interface TriggerDecision {
  groupMatched: boolean;
  matchedPendingGroupTrigger: boolean;
  shouldTriggerResponse: boolean;
}
