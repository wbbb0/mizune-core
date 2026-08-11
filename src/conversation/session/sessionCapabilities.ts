import type {
  InlineSessionTriggerExecution,
  InternalSessionTriggerExecution,
  InternalTranscriptItem,
  PersistedSessionState,
  QueuedGroupReplyTarget,
  SessionDelivery,
  SessionDebugControlState,
  SessionDebugMarker,
  SessionMessage,
  SessionPhase,
  SessionSentMessage,
  SessionState,
  SessionUsageSnapshot,
  SessionParticipantRef,
  TranscriptContentSafetyEvent,
  TranscriptItemDeliveryRef,
  TranscriptProfilePhaseTransitionItem,
  TranscriptItemRuntimeExclusionReason,
  TranscriptItemSourceRef
} from "./sessionTypes.ts";
import type { SessionOperationMode } from "./sessionOperationMode.ts";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { ToolObservationSummary } from "./toolObservation.ts";
import type { SessionTaskTracker } from "#conversation/taskTracker/taskTrackerTypes.ts";

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
  getModeId(sessionId: string): string;
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
    toolObservationsToCompress: ToolObservationSummary[];
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
    toolObservationsToCompress: ToolObservationSummary[];
    transcriptStartIndexToKeep: number;
    estimatedTotalTokens: number;
    totalTokens: number;
    tokenBudget: import("./promptTokenBudget.ts").PromptTokenBudgetEstimate;
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
  subscribeSessions(listener: () => void): () => void;
}

export interface SessionWebStreamState {
  id: string;
  type: "private" | "group";
  modeId: string;
  pendingMessages: SessionMessage[];
  phase: SessionPhase;
  mutationEpoch: number;
  lastActiveAt: number;
  internalTranscript: InternalTranscriptItem[];
  activeAssistantResponse: SessionState["activeAssistantResponse"];
  debounceTimer: NodeJS.Timeout | null;
}

export interface SessionWebStreamAccess {
  getSession(sessionId: string): SessionWebStreamState;
  hasActiveResponse(sessionId: string): boolean;
  subscribeSession(sessionId: string, listener: () => void): () => void;
}

export interface SessionToolRuntimeAccess extends SessionOperationModeAccess {
  listSessions(): SessionState[];
  ensureSession(target: {
    id: string;
    type: "private" | "group";
    source?: "onebot" | "web";
    participantRef?: SessionParticipantRef;
    title?: string | null;
    titleSource?: "default" | "auto" | "manual" | null;
  }): SessionState;
  getSession(sessionId: string): SessionState;
  subscribeSession(sessionId: string, listener: () => void): () => void;
  getSessionView(sessionId: string): SessionViewSnapshot;
  getLlmVisibleHistory(sessionId: string): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  getModeId(sessionId: string): string;
  setTitle(sessionId: string, title: string, titleSource: "default" | "auto" | "manual"): SessionState;
  setModeId(sessionId: string, modeId: string, options?: { appendSwitchMarker?: boolean }): boolean;
  appendAssistantHistory(
    sessionId: string,
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
      deliveryRef?: TranscriptItemDeliveryRef;
    },
    timestampMs?: number
  ): void;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
  appendProfilePhaseTransition(
    sessionId: string,
    input: {
      target: TranscriptProfilePhaseTransitionItem["target"];
      phase: TranscriptProfilePhaseTransitionItem["phase"];
      action: TranscriptProfilePhaseTransitionItem["action"];
      source: TranscriptProfilePhaseTransitionItem["source"];
    }
  ): void;
  appendDebugMarker(sessionId: string, marker: SessionDebugMarker): void;
  getDebugMarkers(sessionId: string): SessionDebugMarker[];
  recordSentMessage(sessionId: string, message: SessionSentMessage): void;
}

export interface SessionBootstrapPersistenceAccess {
  restoreSessions(items: PersistedSessionState[]): void;
  listSessions(): SessionState[];
}

export interface SessionOperationModeAccess {
  getOperationMode(sessionId: string): SessionOperationMode;
  setOperationMode(sessionId: string, operationMode: SessionOperationMode): SessionOperationMode;
  appendProfilePhaseTransition(
    sessionId: string,
    input: {
      target: TranscriptProfilePhaseTransitionItem["target"];
      phase: TranscriptProfilePhaseTransitionItem["phase"];
      action: TranscriptProfilePhaseTransitionItem["action"];
      source: TranscriptProfilePhaseTransitionItem["source"];
    }
  ): void;
  finishProfileOperation(
    sessionId: string,
    input: {
      action: Extract<TranscriptProfilePhaseTransitionItem["action"], "exit_confirmed" | "exit_cancelled">;
      source: TranscriptProfilePhaseTransitionItem["source"];
    }
  ): boolean;
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
  & SessionTaskTrackerAccess
  & SessionAdminReadAccess
  & SessionAdminMutationAccess
  & SessionOperationModeAccess
  & SessionStreamAccess
  & SessionWebStreamAccess;

export interface SessionSetupAccess {
  isSetupConfirmed(sessionId: string): boolean;
}

export interface SessionTaskTrackerAccess {
  getTaskTracker(sessionId: string): SessionTaskTracker;
  updateTaskTracker(
    sessionId: string,
    updater: (current: SessionTaskTracker) => SessionTaskTracker
  ): SessionTaskTracker;
  setTaskTracker(sessionId: string, tracker: SessionTaskTracker): SessionTaskTracker;
}

// Minimal admin-facing session snapshot used by the internal API.
export interface SessionViewSnapshot {
  id: string;
  type: "private" | "group";
  source: "onebot" | "web";
  modeId: string;
  participantUserId: string;
  participantLabel: string | null;
  pacingPreferences: SessionState["pacingPreferences"];
  debugControl: SessionDebugControlState;
  historySummary: string | null;
  taskTracker: SessionTaskTracker;
  internalTranscript: InternalTranscriptItem[];
  debugMarkers: SessionDebugMarker[];
  lastLlmUsage: SessionUsageSnapshot | null;
  sentMessages: SessionSentMessage[];
  lastActiveAt: number;
}

// Read-only admin queries for listing sessions and inspecting snapshots.
export interface SessionAdminReadAccess {
  listSessions(): SessionState[];
  getSessionView(sessionId: string): SessionViewSnapshot;
  getLlmVisibleHistory(sessionId: string): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  getHistoryRevision(sessionId: string): number;
  getMutationEpoch(sessionId: string): number;
  subscribeSessions(listener: () => void): () => void;
}

// Admin mutations for creating, switching, persisting, and deleting sessions.
export interface SessionAdminMutationAccess {
  ensureSession(target: {
    id: string;
    type: "private" | "group";
    source?: "onebot" | "web";
    participantRef?: SessionParticipantRef;
    title?: string | null;
    titleSource?: "default" | "auto" | "manual" | null;
  }): SessionState;
  getSession(sessionId: string): SessionState;
  setTitle(sessionId: string, title: string, titleSource: "default" | "auto" | "manual"): SessionState;
  setSettings(
    sessionId: string,
    settings: Pick<SessionState, "pacingPreferences" | "toolsetPreferences">
  ): Pick<SessionState, "pacingPreferences" | "toolsetPreferences">;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
  setModeId(sessionId: string, modeId: string, options?: { appendSwitchMarker?: boolean }): boolean;
  getPersistedSession(sessionId: string): PersistedSessionState;
  restorePersistedSession(item: PersistedSessionState): SessionState;
  deleteSession(sessionId: string): boolean;
  excludeTranscriptItem(
    sessionId: string,
    itemId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs?: number
  ): InternalTranscriptItem[];
  excludeTranscriptGroup(
    sessionId: string,
    groupId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs?: number
  ): InternalTranscriptItem[];
  excludeTranscriptItemsAfter(
    sessionId: string,
    itemId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs?: number
  ): InternalTranscriptItem[];
  reactivateTranscriptUserBatch(
    sessionId: string,
    itemId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs?: number
  ): {
    messages: SessionMessage[];
    excludedItems: InternalTranscriptItem[];
    activeGroupId: string;
  };
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
      deliveryRef?: TranscriptItemDeliveryRef;
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
    participantRef?: SessionParticipantRef;
    title?: string | null;
    titleSource?: "default" | "auto" | "manual" | null;
  }): SessionState;
  hasActiveResponse(sessionId: string): boolean;
  hasQueuedGroupReplyTargets(sessionId: string): boolean;
  hasPendingInternalTriggers(sessionId: string): boolean;
  hasPendingInlineTriggers(sessionId: string): boolean;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
  enqueueInternalTrigger(sessionId: string, trigger: InternalSessionTriggerExecution): number;
  enqueueInlineTrigger(sessionId: string, trigger: InlineSessionTriggerExecution): number;
}

export interface SessionDirectCommandAccess {
  ensureSession(target: {
    id: string;
    type: "private" | "group";
    source?: "onebot" | "web";
    participantRef?: SessionParticipantRef;
    title?: string | null;
    titleSource?: "default" | "auto" | "manual" | null;
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
      contentParts?: SessionMessage["contentParts"];
      images: string[];
      audioSources?: string[];
      audioIds?: string[];
      emojiSources?: string[];
      imageIds?: string[];
      emojiIds?: string[];
      attachments?: SessionMessage["attachments"];
      messageFiles?: SessionMessage["messageFiles"];
      specialSegments?: SessionMessage["specialSegments"];
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
      contentParts?: SessionMessage["contentParts"];
      imageIds?: string[];
      emojiIds?: string[];
      attachments?: SessionMessage["attachments"];
      messageFiles?: SessionMessage["messageFiles"];
      specialSegments?: SessionMessage["specialSegments"];
      audioCount?: number;
      forwardIds?: string[];
      replyMessageId?: string | null;
      mentionUserIds?: string[];
    mentionedAll?: boolean;
    mentionedSelf?: boolean;
    sourceRef?: TranscriptItemSourceRef;
    contentSafetyEvents?: TranscriptContentSafetyEvent[];
  },
    timestampMs?: number,
    options?: { transcriptGroup?: "pending" | "standalone"; transcriptGroupId?: string }
  ): void;
  canInsertUserHistoryByTimestamp(
    sessionId: string,
    input: {
      sourceRef?: TranscriptItemSourceRef;
      timestampMs: number;
    }
  ): boolean;
  insertUserHistoryByTimestamp(
    sessionId: string,
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
      contentParts?: SessionMessage["contentParts"];
      imageIds?: string[];
      emojiIds?: string[];
      attachments?: SessionMessage["attachments"];
      messageFiles?: SessionMessage["messageFiles"];
      specialSegments?: SessionMessage["specialSegments"];
      audioCount?: number;
      forwardIds?: string[];
      replyMessageId?: string | null;
      mentionUserIds?: string[];
      mentionedAll?: boolean;
      mentionedSelf?: boolean;
      sourceRef?: TranscriptItemSourceRef;
      contentSafetyEvents?: TranscriptContentSafetyEvent[];
    },
    timestampMs?: number
  ): boolean;
  hasHistorySource(sessionId: string, sourceRef: TranscriptItemSourceRef): boolean;
  getDebugControlState(sessionId: string): SessionDebugControlState;
  getOperationMode(sessionId: string): SessionOperationMode;
  setOperationMode(sessionId: string, operationMode: SessionOperationMode): SessionOperationMode;
  appendProfilePhaseTransition(
    sessionId: string,
    input: {
      target: TranscriptProfilePhaseTransitionItem["target"];
      phase: TranscriptProfilePhaseTransitionItem["phase"];
      action: TranscriptProfilePhaseTransitionItem["action"];
      source: TranscriptProfilePhaseTransitionItem["source"];
    }
  ): void;
  finishProfileOperation(
    sessionId: string,
    input: {
      action: Extract<TranscriptProfilePhaseTransitionItem["action"], "exit_confirmed" | "exit_cancelled">;
      source: TranscriptProfilePhaseTransitionItem["source"];
    }
  ): boolean;
  getLlmVisibleHistory(sessionId: string): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
  setTitle(sessionId: string, title: string, titleSource: "default" | "auto" | "manual"): SessionState;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
  isGenerating(sessionId: string): boolean;
  cancelGeneration(sessionId: string): boolean;
  interruptResponse(sessionId: string): {
    cancelledGeneration: boolean;
    cancelledOutbound: boolean;
    finalizedAssistant: boolean;
    finalizedDraftAssistant: boolean;
  };
  clearSession(sessionId: string): void;
  popRetractableSentMessages(sessionId: string, count: number, maxAgeMs: number, now?: number): SessionSentMessage[];
  setDebugEnabled(sessionId: string, enabled: boolean): SessionDebugControlState;
  armDebugOnce(sessionId: string): SessionDebugControlState;
  markSetupConfirmed(sessionId: string): void;
  clearPendingTranscriptGroup(sessionId: string): void;
}

export interface SessionMessagingAccess {
  getOrCreateSession(message: ParsedIncomingMessage): SessionState;
  getSession(sessionId: string): SessionState;
  appendUserHistory(
    sessionId: string,
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
      contentParts?: SessionMessage["contentParts"];
      imageIds?: string[];
      emojiIds?: string[];
      attachments?: SessionMessage["attachments"];
      messageFiles?: SessionMessage["messageFiles"];
      specialSegments?: SessionMessage["specialSegments"];
      audioCount?: number;
      forwardIds?: string[];
      replyMessageId?: string | null;
      mentionUserIds?: string[];
      mentionedAll?: boolean;
      mentionedSelf?: boolean;
      sourceRef?: TranscriptItemSourceRef;
      contentSafetyEvents?: TranscriptContentSafetyEvent[];
    },
    timestampMs?: number,
    options?: { transcriptGroup?: "pending" | "standalone"; transcriptGroupId?: string }
  ): void;
  hasHistorySource(sessionId: string, sourceRef: TranscriptItemSourceRef): boolean;
  appendAssistantHistory(
    sessionId: string,
    message: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
      text: string;
      deliveryRef?: TranscriptItemDeliveryRef;
    },
    timestampMs?: number
  ): void;
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
  setReplyDelivery(sessionId: string, delivery: SessionDelivery): void;
  hasActiveResponse(sessionId: string): boolean;
  appendSteerMessage(sessionId: string, message: ParsedIncomingMessage): SessionState;
  interruptOutbound(sessionId: string): boolean;
  interruptResponse(sessionId: string): {
    cancelledGeneration: boolean;
    cancelledOutbound: boolean;
    finalizedAssistant: boolean;
    finalizedDraftAssistant: boolean;
  };
  appendPendingMessage(sessionId: string, message: ParsedIncomingMessage): SessionState;
  enqueueGroupReplyTarget(sessionId: string, message: ParsedIncomingMessage): QueuedGroupReplyTarget;
  hasQueuedGroupReplyTargets(sessionId: string): boolean;
  promoteNextQueuedGroupReplyTarget(sessionId: string): number;
  clearPendingTranscriptGroup(sessionId: string): void;
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
  hasQueuedGroupReplyTargets(sessionId: string): boolean;
  promoteNextQueuedGroupReplyTarget(sessionId: string): number;
  clearDebounceTimer(sessionId: string): void;
  shiftInternalTrigger(sessionId: string): InternalSessionTriggerExecution | null;
  hasPendingInlineTriggers(sessionId: string): boolean;
  drainInlineTriggers(sessionId: string): InlineSessionTriggerExecution[];
  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void;
}

export interface SessionGenerationOutboundAccess {
  getPacingPreferences(sessionId: string): SessionState["pacingPreferences"];
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
      deliveryRef?: TranscriptItemDeliveryRef;
    },
    timestampMs?: number
  ): boolean;
  recordSentMessage(sessionId: string, message: SessionSentMessage): void;
}

export interface SessionGenerationOrchestratorAccess extends SessionSetupAccess, SessionOperationModeAccess, SessionTaskTrackerAccess {
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
  drainInlineTriggers(sessionId: string): InlineSessionTriggerExecution[];
  hasPendingInlineTriggers(sessionId: string): boolean;
  setSessionPhaseIfEpochMatches(sessionId: string, expectedEpoch: number, phase: SessionPhase): boolean;
  appendInternalTranscriptIfEpochMatches(sessionId: string, expectedEpoch: number, item: InternalTranscriptItem): boolean;
  setLastLlmUsageIfEpochMatches(sessionId: string, expectedEpoch: number, usage: SessionUsageSnapshot): boolean;
  finishGeneration(sessionId: string, abortController: AbortController): boolean;
  getModeId(sessionId: string): string;
  clearSession(sessionId: string): void;
  finishProfileOperation(
    sessionId: string,
    input: {
      action: Extract<TranscriptProfilePhaseTransitionItem["action"], "exit_confirmed" | "exit_cancelled">;
      source: TranscriptProfilePhaseTransitionItem["source"];
    }
  ): boolean;
  isResponseOpen(sessionId: string, expectedResponseEpoch: number): boolean;
  setLastAssistantReasoningIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    reasoningContent: string
  ): boolean;
  setLastAssistantProviderMetadataIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    providerMetadata: Record<string, unknown>
  ): boolean;
  applyActiveResponseTokenStatsIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    input: {
      outputTokens: number | null;
      reasoningTokens: number | null;
      modelRef: string | null;
      model: string | null;
      providerReported: boolean;
      capturedAt: number;
    }
  ): boolean;
  finalizeActiveAssistantResponseIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    timestampMs?: number
  ): SessionState["activeAssistantResponse"];
  setActiveAssistantDraftResponseIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    target: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
    },
    text: string,
    timestampMs?: number
  ): boolean;
  hasPendingSteerMessages(sessionId: string): boolean;
  promoteSteerMessagesToPending(sessionId: string): number;
  completeResponse(sessionId: string, expectedResponseEpoch: number): boolean;
  getSession(sessionId: string): SessionState;
  hasActiveResponse(sessionId: string): boolean;
  getTaskTracker(sessionId: string): SessionTaskTracker;
  updateTaskTracker(
    sessionId: string,
    updater: (current: SessionTaskTracker) => SessionTaskTracker
  ): SessionTaskTracker;
  setTaskTracker(sessionId: string, tracker: SessionTaskTracker): SessionTaskTracker;
}

export type SessionGenerationRuntimeAccess =
  SessionGenerationQueueAccess
  & SessionGenerationOrchestratorAccess
  & SessionGenerationExecutionAccess
  & SessionGenerationOutboundAccess
  & SessionTurnPlannerAccess
  & SessionInternalTriggerDispatchAccess
  & SessionToolRuntimeAccess;
