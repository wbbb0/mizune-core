import type {
  InternalSessionTriggerExecution,
  InternalTranscriptItem,
  PersistedSessionState,
  SessionDelivery,
  SessionDebugControlState,
  SessionDebugMarker,
  SessionMessage,
  SessionPhase,
  SessionSentMessage,
  SessionState,
  SessionToolEvent,
  SessionUsageSnapshot
} from "./sessionTypes.ts";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";

// These capability slices let downstream modules depend on the session surface
// they actually use instead of importing the whole SessionManager facade.
export interface SessionConversationCatalog {
  listSessions(): SessionState[];
  getLlmVisibleHistory(sessionId: string): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
}

export interface SessionDebounceAccess {
  getSession(sessionId: string): SessionState;
  clearDebounceTimer(sessionId: string): void;
  setDebounceTimer(sessionId: string, timer: NodeJS.Timeout): void;
}

export interface SessionCompressionAccess {
  getHistoryRevision(sessionId: string): number;
  getLastLlmUsage(sessionId: string): SessionUsageSnapshot | null;
  getHistoryForCompression(
    sessionId: string,
    triggerMessageCount: number,
    retainMessageCount: number
  ): {
    historySummary: string | null;
    messagesToCompress: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    retainedMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    transcriptStartIndexToKeep: number;
  } | null;
  getHistoryForCompressionByTokens(
    sessionId: string,
    triggerTokens: number,
    retainTokens: number,
    reportedInputTokens?: number
  ): {
    historySummary: string | null;
    messagesToCompress: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    retainedMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    transcriptStartIndexToKeep: number;
    estimatedTotalTokens: number;
  } | null;
  applyCompressedHistoryIfHistoryRevisionMatches(
    sessionId: string,
    expectedHistoryRevision: number,
    payload: {
      historySummary: string;
      transcriptStartIndexToKeep: number;
    }
  ): boolean;
}

export interface SessionStreamAccess {
  getSession(sessionId: string): SessionState;
  hasActiveResponse(sessionId: string): boolean;
  subscribeSession(sessionId: string, listener: () => void): () => void;
}

export type SessionWebStreamState = Pick<
  SessionState,
  | "id"
  | "type"
  | "source"
  | "modeId"
  | "participantUserId"
  | "participantLabel"
  | "pendingMessages"
  | "phase"
  | "historyRevision"
  | "mutationEpoch"
  | "lastActiveAt"
  | "internalTranscript"
  | "recentToolEvents"
  | "activeAssistantResponse"
  | "debounceTimer"
>;

export interface SessionWebStreamAccess {
  getSession(sessionId: string): SessionWebStreamState;
  hasActiveResponse(sessionId: string): boolean;
  subscribeSession(sessionId: string, listener: () => void): () => void;
}

export interface SessionToolRuntimeAccess {
  listSessions(): SessionState[];
  ensureSession(target: {
    id: string;
    type: "private" | "group";
    source?: "onebot" | "web";
    participantUserId?: string;
    participantLabel?: string | null;
  }): SessionState;
  getSession(sessionId: string): SessionState;
  getSessionView(sessionId: string): SessionViewSnapshot;
  getLlmVisibleHistory(sessionId: string): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  getModeId(sessionId: string): string;
  setModeId(sessionId: string, modeId: string, options?: { appendSwitchMarker?: boolean }): boolean;
  appendAssistantHistory(
    sessionId: string,
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
    },
    timestampMs?: number
  ): void;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
  appendDebugMarker(sessionId: string, marker: SessionDebugMarker): void;
  getDebugMarkers(sessionId: string): SessionDebugMarker[];
  recordSentMessage(sessionId: string, message: SessionSentMessage): void;
}

export interface SessionBootstrapPersistenceAccess {
  restoreSessions(items: PersistedSessionState[]): void;
  listSessions(): SessionState[];
}

export type SessionAppRuntimeAccess =
  SessionBootstrapPersistenceAccess
  & SessionCompressionAccess
  & SessionConversationCatalog
  & SessionDebounceAccess
  & SessionDirectCommandAccess
  & SessionGenerationRuntimeAccess
  & SessionMessagingAccess
  & SessionOutboundHistoryAccess
  & SessionPersistenceAccess
  & SessionSetupAccess
  & SessionAdminReadAccess
  & SessionAdminMutationAccess
  & SessionStreamAccess
  & SessionWebStreamAccess;

export interface SessionSetupAccess {
  isSetupConfirmed(sessionId: string): boolean;
}

// Minimal admin-facing session snapshot used by the internal API.
export interface SessionViewSnapshot {
  id: string;
  type: "private" | "group";
  source: "onebot" | "web";
  modeId: string;
  participantUserId: string;
  participantLabel: string | null;
  debugControl: SessionDebugControlState;
  historySummary: string | null;
  internalTranscript: InternalTranscriptItem[];
  debugMarkers: SessionDebugMarker[];
  recentToolEvents: SessionToolEvent[];
  lastLlmUsage: SessionUsageSnapshot | null;
  sentMessages: SessionSentMessage[];
  lastActiveAt: number;
}

// Read-only admin queries for listing sessions and inspecting snapshots.
export interface SessionAdminReadAccess {
  listSessions(): SessionState[];
  getSessionView(sessionId: string): SessionViewSnapshot;
  getHistoryRevision(sessionId: string): number;
  getMutationEpoch(sessionId: string): number;
}

// Admin mutations for creating, switching, persisting, and deleting sessions.
export interface SessionAdminMutationAccess {
  ensureSession(target: {
    id: string;
    type: "private" | "group";
    source?: "onebot" | "web";
    participantUserId?: string;
    participantLabel?: string | null;
  }): SessionState;
  getSession(sessionId: string): SessionState;
  setModeId(sessionId: string, modeId: string, options?: { appendSwitchMarker?: boolean }): boolean;
  getPersistedSession(sessionId: string): PersistedSessionState;
  deleteSession(sessionId: string): boolean;
}

export interface SessionPersistenceAccess {
  getPersistedSession(sessionId: string): PersistedSessionState;
}

export interface SessionOutboundHistoryAccess {
  recordSentMessage(sessionId: string, message: SessionSentMessage): void;
  appendAssistantHistory(
    sessionId: string,
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
    },
    timestampMs?: number
  ): void;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
}

export interface SessionInternalTriggerDispatchAccess {
  ensureSession(target: {
    id: string;
    type: "private" | "group";
    source?: "onebot" | "web";
    participantUserId?: string;
    participantLabel?: string | null;
  }): SessionState;
  hasActiveResponse(sessionId: string): boolean;
  hasPendingInternalTriggers(sessionId: string): boolean;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
  enqueueInternalTrigger(sessionId: string, trigger: InternalSessionTriggerExecution): number;
}

export interface SessionDirectCommandAccess {
  ensureSession(target: {
    id: string;
    type: "private" | "group";
    source?: "onebot" | "web";
    participantUserId?: string;
    participantLabel?: string | null;
  }): SessionState;
  appendDebugMarker(sessionId: string, marker: SessionDebugMarker): void;
  appendSyntheticPendingMessage(
    sessionId: string,
    message: {
      chatType: "private" | "group";
      userId: string;
      groupId?: string;
      senderName: string;
      text: string;
      images: string[];
      audioSources?: string[];
      audioIds?: string[];
      emojiSources?: string[];
      imageIds?: string[];
      emojiIds?: string[];
      attachments?: SessionMessage["attachments"];
      forwardIds?: string[];
      replyMessageId?: string | null;
      mentionUserIds?: string[];
      mentionedAll?: boolean;
      isAtMentioned?: boolean;
    }
  ): SessionState;
  appendUserHistory(
    sessionId: string,
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
      imageIds?: string[];
      emojiIds?: string[];
      attachments?: SessionMessage["attachments"];
      audioCount?: number;
      forwardIds?: string[];
      replyMessageId?: string | null;
      mentionUserIds?: string[];
      mentionedAll?: boolean;
      mentionedSelf?: boolean;
    },
    timestampMs?: number
  ): void;
  getDebugControlState(sessionId: string): SessionDebugControlState;
  getLlmVisibleHistory(sessionId: string): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  isGenerating(sessionId: string): boolean;
  cancelGeneration(sessionId: string): boolean;
  clearSession(sessionId: string): void;
  popRetractableSentMessages(sessionId: string, count: number, maxAgeMs: number, now?: number): SessionSentMessage[];
  setDebugEnabled(sessionId: string, enabled: boolean): SessionDebugControlState;
  armDebugOnce(sessionId: string): SessionDebugControlState;
  markSetupConfirmed(sessionId: string): void;
}

export interface SessionMessagingAccess {
  getOrCreateSession(message: ParsedIncomingMessage): SessionState;
  getSession(sessionId: string): SessionState;
  matchesInterruptibleGroupTriggerUser(sessionId: string, userId: string): boolean;
  appendUserHistory(
    sessionId: string,
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
      imageIds?: string[];
      emojiIds?: string[];
      attachments?: SessionMessage["attachments"];
      audioCount?: number;
      forwardIds?: string[];
      replyMessageId?: string | null;
      mentionUserIds?: string[];
      mentionedAll?: boolean;
      mentionedSelf?: boolean;
    },
    timestampMs?: number
  ): void;
  appendAssistantHistory(
    sessionId: string,
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
    },
    timestampMs?: number
  ): void;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
  setReplyDelivery(sessionId: string, delivery: SessionDelivery): void;
  setInterruptibleGroupTriggerUser(sessionId: string, userId: string | null): void;
  hasActiveResponse(sessionId: string): boolean;
  appendSteerMessage(sessionId: string, message: ParsedIncomingMessage): SessionState;
  interruptOutbound(sessionId: string): boolean;
  appendPendingMessage(sessionId: string, message: ParsedIncomingMessage): SessionState;
}

export interface SessionTurnPlannerAccess {
  requeuePendingMessages(sessionId: string, messages: SessionMessage[], replyGateWaitPasses: number): void;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
}

export interface SessionGenerationQueueAccess {
  getSession(sessionId: string): SessionState;
  hasActiveResponse(sessionId: string): boolean;
  hasPendingSteerMessages(sessionId: string): boolean;
  promoteSteerMessagesToPending(sessionId: string): number;
  clearDebounceTimer(sessionId: string): void;
  shiftInternalTrigger(sessionId: string): InternalSessionTriggerExecution | null;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
}

export interface SessionGenerationOutboundAccess {
  appendActiveAssistantResponseChunkIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    target: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
    },
    chunk: string,
    timestampMs?: number,
    options?: {
      joinWithDoubleNewline?: boolean | undefined;
    }
  ): boolean;
  appendHistoryIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    target: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
    },
    timestampMs?: number
  ): boolean;
  recordSentMessage(sessionId: string, message: SessionSentMessage): void;
}

export interface SessionGenerationOrchestratorAccess extends SessionSetupAccess {
  getSession(sessionId: string): SessionState;
  getReplyDelivery(sessionId: string): SessionDelivery;
  setReplyDelivery(sessionId: string, delivery: SessionDelivery): void;
  requeuePendingMessages(sessionId: string, messages: SessionMessage[], replyGateWaitPasses: number): void;
  beginGeneration(sessionId: string): {
    session: SessionState;
    messages: SessionMessage[];
    pendingReplyGateWaitPasses: number;
    abortController: AbortController;
    responseAbortController: AbortController;
    responseEpoch: number;
  };
  beginSyntheticGeneration(sessionId: string): {
    session: SessionState;
    abortController: AbortController;
    responseAbortController: AbortController;
    responseEpoch: number;
  };
  getMutationEpoch(sessionId: string): number;
  finishGeneration(sessionId: string, abortController: AbortController): boolean;
  completeResponse(sessionId: string, expectedResponseEpoch: number): boolean;
  consumeDebugMode(sessionId: string): boolean;
  getDebugControlState(sessionId: string): SessionDebugControlState;
  getDebugMarkers(sessionId: string): SessionDebugMarker[];
  isGenerating(sessionId: string): boolean;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
}

export interface SessionGenerationExecutionAccess extends SessionSetupAccess {
  consumeSteerMessages(sessionId: string): SessionMessage[];
  appendToolEventIfEpochMatches(sessionId: string, expectedEpoch: number, event: SessionToolEvent): boolean;
  setSessionPhaseIfEpochMatches(sessionId: string, expectedEpoch: number, phase: SessionPhase): boolean;
  appendInternalTranscriptIfEpochMatches(sessionId: string, expectedEpoch: number, item: InternalTranscriptItem): boolean;
  setLastLlmUsageIfEpochMatches(sessionId: string, expectedEpoch: number, usage: SessionUsageSnapshot): boolean;
  finishGeneration(sessionId: string, abortController: AbortController): boolean;
  getModeId(sessionId: string): string;
  clearSession(sessionId: string): void;
  isResponseOpen(sessionId: string, expectedResponseEpoch: number): boolean;
  setLastAssistantReasoningIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    reasoningContent: string
  ): boolean;
  finalizeActiveAssistantResponseIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    timestampMs?: number
  ): SessionState["activeAssistantResponse"];
  hasPendingSteerMessages(sessionId: string): boolean;
  promoteSteerMessagesToPending(sessionId: string): number;
  completeResponse(sessionId: string, expectedResponseEpoch: number): boolean;
  getSession(sessionId: string): SessionState;
  hasActiveResponse(sessionId: string): boolean;
}

export type SessionGenerationRuntimeAccess =
  SessionGenerationQueueAccess
  & SessionGenerationOrchestratorAccess
  & SessionGenerationExecutionAccess
  & SessionGenerationOutboundAccess
  & SessionTurnPlannerAccess
  & SessionInternalTriggerDispatchAccess
  & SessionToolRuntimeAccess;
