import type { Relationship } from "#identity/relationship.ts";
import type { AppServiceBootstrap } from "../bootstrap/appServiceBootstrap.ts";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { SessionMessagingAccess } from "#conversation/session/sessionCapabilities.ts";
import type { InternalTranscriptItem } from "#conversation/session/sessionTypes.ts";
import type { SessionDelivery, SessionState } from "#conversation/session/sessionTypes.ts";
import type {
  GenerationCommittedTextSink,
  GenerationDraftOverlaySink
} from "#app/generation/generationOutputContracts.ts";
import type { ResolvedDirectCommand } from "./directCommands.ts";

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
    | "personaStore"
    | "rpProfileStore"
    | "scenarioProfileStore"
    | "setupStore"
    | "globalProfileReadinessStore"
    | "conversationAccess"
  >, "sessionManager"> & {
    sessionManager: SessionMessagingAccess & import("#conversation/session/sessionCapabilities.ts").SessionOperationModeAccess;
    contentSafetyService?: Pick<import("#contentSafety/contentSafetyService.ts").ContentSafetyService, "moderateIncomingMessage">;
  };
  handleDirectCommand: (input: {
    command: ResolvedDirectCommand;
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
    externalUserId?: string;
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
    committedTextSink?: GenerationCommittedTextSink;
    draftOverlaySink?: GenerationDraftOverlaySink;
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
