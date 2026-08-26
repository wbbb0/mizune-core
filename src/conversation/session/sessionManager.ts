import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { AppConfig } from "#config/config.ts";
import { isSessionGenerating, isSessionResponding } from "./sessionQueries.ts";
import {
  setSessionPhaseState,
  appendActiveAssistantResponseChunkState,
  appendSessionMessage,
  appendSteerMessageState,
  clearSessionState,
  consumeSteerMessagesState,
  finalizeActiveAssistantDraftResponseState,
  finalizeActiveAssistantResponseState,
  promoteSteerMessagesToPendingState,
  promoteNextQueuedGroupReplyTargetState,
  requeuePendingMessagesState,
  resetProfileOperationState,
  setActiveAssistantDraftResponseState,
  setSessionOperationModeState,
  setSessionSettingsState,
  patchSessionBotProfileState,
  clearSessionBotProfileState,
  enqueueGroupReplyTargetState
} from "./sessionMutations.ts";
import { SessionStore } from "./sessionStore.ts";
import {
  buildSessionId,
  createSessionState,
  restoreSessionState,
  toPersistedSessionState
} from "./sessionStateFactory.ts";
import { resolveSessionParticipantRef } from "./sessionIdentity.ts";
import { SessionLifecycleController } from "./sessionLifecycleController.ts";
import { SessionInternalTriggerQueue } from "./sessionInternalTriggerQueue.ts";
import { SessionInlineTriggerQueue } from "./sessionInlineTriggerQueue.ts";
import { SessionDebugController } from "./sessionDebugController.ts";
import { SessionSentMessageLog } from "./sessionSentMessageLog.ts";
import { SessionHistoryService } from "./sessionHistoryService.ts";
import { clearPendingTranscriptGroup } from "./transcriptMetadata.ts";
import type {
  SessionPhase,
  ActiveAssistantResponse,
  DebugLiteral,
  InlineSessionTriggerExecution,
  InternalSessionTriggerExecution,
  InternalTranscriptItem,
  PersistedSessionState,
  QueuedGroupReplyTarget,
  SessionDelivery,
  SessionDebugMarker,
  SessionDebugControlState,
  SessionMessage,
  SessionSentMessage,
  SessionState,
  SessionTitleSource,
  SessionUsageSnapshot,
  TranscriptItemDeliveryRef,
  TranscriptProfilePhaseTransitionItem,
  TranscriptItemRuntimeExclusionReason,
  TranscriptItemSourceRef,
  TranscriptUserMediaMessageItem,
  TranscriptUserMessageItem
} from "./sessionTypes.ts";
import {
  cloneSessionOperationMode,
  getSessionOperationProfilePhase,
  type SessionOperationMode
} from "./sessionOperationMode.ts";
import type { ToolObservationSummary } from "./toolObservation.ts";
import { normalizeTaskTracker } from "#conversation/taskTracker/taskTrackerNormalize.ts";
import type { SessionTaskTracker } from "#conversation/taskTracker/taskTrackerTypes.ts";
import type { SessionBotProfile, SessionBotProfileField } from "./sessionBotProfile.ts";

export type {
  ActiveAssistantResponse,
  DebugLiteral,
  InlineSessionTriggerExecution,
  InternalSessionTriggerExecution,
  InternalTranscriptItem,
  PersistedSessionMessage,
  PersistedSessionState,
  SessionDelivery,
  SessionDebugMarker,
  SessionHistoryMessage,
  SessionMessage,
  SessionSentMessage,
  SessionState,
  SessionUsageSnapshot
} from "./sessionTypes.ts";
export type { SessionOperationMode } from "./sessionOperationMode.ts";

// Owns the runtime session map and exposes the public session mutation API.
export class SessionManager {
  private readonly sessionStore = new SessionStore();
  private readonly lifecycleController = new SessionLifecycleController();
  private readonly internalTriggerQueue = new SessionInternalTriggerQueue();
  private readonly inlineTriggerQueue = new SessionInlineTriggerQueue();
  private readonly debugController = new SessionDebugController();
  private readonly sentMessageLog = new SessionSentMessageLog();
  private readonly historyService: SessionHistoryService;
  private readonly sessionListeners = new Map<string, Set<() => void>>();
  private readonly allSessionListeners = new Set<() => void>();

  constructor(config: AppConfig) {
    this.historyService = new SessionHistoryService(config);
  }

  // Returns the existing session for an incoming message or creates a new one.
  getOrCreateSession(message: ParsedIncomingMessage): SessionState {
    const sessionId = buildSessionId(message);
    const existing = this.sessionStore.get(sessionId);
    if (existing) {
      return existing;
    }

    const created = createSessionState({
      id: sessionId,
      type: message.chatType,
      participantRef: resolveSessionParticipantRef({
        sessionId,
        type: message.chatType,
        participantRef: message.chatType === "group"
          ? { kind: "group", id: message.groupId ?? "unknown" }
          : { kind: "user", id: message.userId }
      })
    });
    this.sessionStore.set(sessionId, created);
    this.notifySessionChanged(sessionId);
    return created;
  }

  appendPendingMessage(sessionId: string, message: ParsedIncomingMessage): SessionState {
    const session = this.requireSession(sessionId);
    const updated = appendSessionMessage(session, message);
    this.notifySessionChanged(sessionId);
    return updated;
  }

  enqueueGroupReplyTarget(sessionId: string, message: ParsedIncomingMessage): QueuedGroupReplyTarget {
    const session = this.requireSession(sessionId);
    const target = enqueueGroupReplyTargetState(session, message);
    this.notifySessionChanged(sessionId);
    return target;
  }

  hasQueuedGroupReplyTargets(sessionId: string): boolean {
    return this.requireSession(sessionId).queuedGroupReplyTargets.length > 0;
  }

  promoteNextQueuedGroupReplyTarget(sessionId: string): number {
    const session = this.requireSession(sessionId);
    const promoted = promoteNextQueuedGroupReplyTargetState(session);
    if (promoted) {
      this.notifySessionChanged(sessionId);
      return promoted.messages.length;
    }
    return 0;
  }

  appendSteerMessage(sessionId: string, message: ParsedIncomingMessage): SessionState {
    const session = this.requireSession(sessionId);
    const updated = appendSteerMessageState(session, message);
    this.notifySessionChanged(sessionId);
    return updated;
  }

  // Ensures a session exists for a known target id and type.
  ensureSession(target: {
    id: string;
    type: "private" | "group";
    source?: "onebot" | "web";
    participantRef?: SessionState["participantRef"];
    title?: string | null;
    titleSource?: "default" | "auto" | "manual" | null;
  }): SessionState {
    const existing = this.sessionStore.get(target.id);
    if (existing) {
      return existing;
    }

    const created = createSessionState({
      id: target.id,
      type: target.type,
      ...(target.source ? { source: target.source } : {}),
      ...(target.participantRef ? { participantRef: target.participantRef } : {}),
      ...(target.title !== undefined ? {
        title: target.title,
        titleSource: target.titleSource ?? (String(target.title ?? "").trim() ? "manual" : "default")
      } : {})
    });
    this.sessionStore.set(target.id, created);
    this.notifySessionChanged(target.id);
    return created;
  }

  setTitle(sessionId: string, title: string, titleSource: SessionTitleSource): SessionState {
    const session = this.requireSession(sessionId);
    const normalizedTitle = String(title ?? "").trim();
    if (!normalizedTitle) {
      throw new Error("title is required");
    }
    session.title = normalizedTitle;
    session.titleSource = titleSource;
    session.lastActiveAt = Date.now();
    this.notifySessionChanged(sessionId);
    return session;
  }

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
  ): SessionState {
    const session = this.requireSession(sessionId);
    const updated = appendSessionMessage(session, {
      ...message,
      ...(message.contentParts && message.contentParts.length > 0 ? { contentParts: message.contentParts } : {}),
      audioSources: message.audioSources ?? [],
      audioIds: message.audioIds ?? [],
      emojiSources: message.emojiSources ?? [],
      imageIds: message.imageIds ?? [],
      emojiIds: message.emojiIds ?? [],
      attachments: message.attachments ?? [],
      messageFiles: message.messageFiles ?? [],
      ...(message.specialSegments && message.specialSegments.length > 0 ? { specialSegments: message.specialSegments } : {}),
      forwardIds: message.forwardIds ?? [],
      replyMessageId: message.replyMessageId ?? null,
      mentionUserIds: message.mentionUserIds ?? [],
      mentionedAll: message.mentionedAll ?? false,
      isAtMentioned: message.isAtMentioned ?? false
    });
    this.notifySessionChanged(sessionId);
    return updated;
  }

  consumeSteerMessages(sessionId: string): SessionMessage[] {
    const session = this.requireSession(sessionId);
    const consumed = consumeSteerMessagesState(session);
    if (consumed.length > 0) {
      this.notifySessionChanged(sessionId);
    }
    return consumed;
  }

  hasPendingSteerMessages(sessionId: string): boolean {
    return this.requireSession(sessionId).pendingSteerMessages.length > 0;
  }

  promoteSteerMessagesToPending(sessionId: string): number {
    const session = this.requireSession(sessionId);
    const promoted = promoteSteerMessagesToPendingState(session);
    if (promoted > 0) {
      this.notifySessionChanged(sessionId);
    }
    return promoted;
  }

  // Starts a normal generation cycle by consuming pending messages.
  beginGeneration(sessionId: string): {
    session: SessionState;
    messages: SessionMessage[];
    pendingReplyGateWaitPasses: number;
    abortController: AbortController;
    responseAbortController: AbortController;
    responseEpoch: number;
  } {
    const session = this.requireSession(sessionId);
    const result = this.lifecycleController.beginGeneration(session);
    this.notifySessionChanged(sessionId);
    return result;
  }

  // Starts a synthetic generation cycle without consuming pending messages.
  beginSyntheticGeneration(sessionId: string): {
    session: SessionState;
    abortController: AbortController;
    responseAbortController: AbortController;
    responseEpoch: number;
  } {
    const session = this.requireSession(sessionId);
    const result = this.lifecycleController.beginSyntheticGeneration(session);
    this.notifySessionChanged(sessionId);
    return result;
  }

  // Marks the active generation as finished if the abort controller still matches.
  finishGeneration(sessionId: string, abortController: AbortController): boolean {
    const session = this.requireSession(sessionId);
    const finished = this.lifecycleController.finishGeneration(session, abortController);
    if (finished) {
      this.notifySessionChanged(sessionId);
    }
    return finished;
  }

  // Cancels the current generation request for a session.
  cancelGeneration(sessionId: string): boolean {
    const session = this.requireSession(sessionId);
    const cancelled = this.lifecycleController.cancelGeneration(session);
    if (cancelled) {
      this.notifySessionChanged(sessionId);
    }
    return cancelled;
  }

  // Aborts the outbound message queue for a session without cancelling generation.
  // Queued messages that have not been sent yet will be skipped.
  // Generation and tool execution continue running.
  interruptOutbound(sessionId: string): boolean {
    const session = this.requireSession(sessionId);
    const interrupted = this.lifecycleController.interruptOutbound(session);
    if (interrupted) {
      this.notifySessionChanged(sessionId);
    }
    return interrupted;
  }

  // Interrupts the active response and invalidates response-scoped background writes.
  interruptResponse(sessionId: string): {
    cancelledGeneration: boolean;
    cancelledOutbound: boolean;
    finalizedAssistant: boolean;
    finalizedDraftAssistant: boolean;
  } {
    const session = this.requireSession(sessionId);
    const activeTranscriptGroupId = session.activeTranscriptGroupId;
    const finalizedDraftAssistant = finalizeActiveAssistantDraftResponseState(session);
    if (finalizedDraftAssistant != null) {
      this.historyService.appendAssistantHistory(
        session,
        {
          chatType: finalizedDraftAssistant.chatType,
          userId: finalizedDraftAssistant.userId,
          senderName: finalizedDraftAssistant.senderName,
          text: finalizedDraftAssistant.text
        },
        finalizedDraftAssistant.lastUpdatedAt
      );
    }
    const interrupted = this.lifecycleController.interruptResponse(session);
    const closedInterruptedToolCalls = activeTranscriptGroupId && interrupted.cancelledGeneration
      ? this.historyService.closeInterruptedToolCalls(session, activeTranscriptGroupId)
      : 0;
    if (
      interrupted.cancelledGeneration
      || interrupted.cancelledOutbound
      || interrupted.finalizedAssistant
      || finalizedDraftAssistant != null
      || closedInterruptedToolCalls > 0
    ) {
      this.notifySessionChanged(sessionId);
    }
    return {
      ...interrupted,
      finalizedDraftAssistant: finalizedDraftAssistant != null
    };
  }

  setSessionPhaseIfEpochMatches(
    sessionId: string,
    expectedEpoch: number,
    phase: SessionPhase
  ): boolean {
    return this.withMutationEpoch(sessionId, expectedEpoch, (session) => {
      setSessionPhaseState(session, phase);
    });
  }

  setDebounceTimer(sessionId: string, timer: NodeJS.Timeout): void {
    const session = this.requireSession(sessionId);
    session.debounceTimer = timer;
    if (session.phase.kind === "idle" || session.phase.kind === "turn_planner_waiting") {
      setSessionPhaseState(session, { kind: "debouncing" });
    }
    this.notifySessionChanged(sessionId);
  }

  clearDebounceTimer(sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (session.debounceTimer != null) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = null;
      if (session.phase.kind === "debouncing") {
        setSessionPhaseState(session, { kind: "idle" });
      }
      this.notifySessionChanged(sessionId);
    }
  }

  // Requeues pending messages after a reply-gate wait decision.
  requeuePendingMessages(sessionId: string, messages: SessionMessage[], replyGateWaitPasses: number): void {
    if (messages.length === 0) {
      return;
    }
    const session = this.requireSession(sessionId);
    requeuePendingMessagesState(session, messages, replyGateWaitPasses);
    if (session.phase.kind === "turn_planner_evaluating" || session.phase.kind === "requesting_llm" || session.phase.kind === "idle") {
      setSessionPhaseState(session, { kind: "turn_planner_waiting" });
    }
    this.notifySessionChanged(sessionId);
  }

  listSessions(): SessionState[] {
    return Array.from(this.sessionStore.values()).map((session) => this.historyService.clone(session));
  }

  deleteSession(sessionId: string): boolean {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      return false;
    }
    this.clearDebounceTimer(sessionId);
    if (session.generationAbortController != null) {
      session.generationAbortController.abort();
    }
    if (session.responseAbortController != null) {
      session.responseAbortController.abort();
    }
    const deleted = this.sessionStore.delete(sessionId);
    if (deleted) {
      this.notifySessionChanged(sessionId);
      this.sessionListeners.delete(sessionId);
    }
    return deleted;
  }

  getSession(sessionId: string): SessionState {
    return this.requireSession(sessionId);
  }

  getReplyDelivery(sessionId: string): SessionDelivery {
    return this.requireSession(sessionId).replyDelivery;
  }

  getPacingPreferences(sessionId: string): SessionState["pacingPreferences"] {
    const preferences = this.requireSession(sessionId).pacingPreferences;
    return {
      inputDebounce: { ...preferences.inputDebounce },
      oneBotOutbound: preferences.oneBotOutbound,
      toolLoopOutput: preferences.toolLoopOutput
    };
  }

  getToolsetPreferences(sessionId: string): SessionState["toolsetPreferences"] {
    return {
      overrides: { ...this.requireSession(sessionId).toolsetPreferences.overrides }
    };
  }

  patchBotProfile(sessionId: string, patch: SessionBotProfile): SessionBotProfile | null {
    const profile = patchSessionBotProfileState(this.requireSession(sessionId), patch);
    this.notifySessionChanged(sessionId);
    return profile == null ? null : { ...profile };
  }

  clearBotProfile(sessionId: string, fields?: readonly SessionBotProfileField[]): SessionBotProfile | null {
    const profile = clearSessionBotProfileState(this.requireSession(sessionId), fields);
    this.notifySessionChanged(sessionId);
    return profile == null ? null : { ...profile };
  }

  getModeId(sessionId: string): string {
    return this.requireSession(sessionId).modeId;
  }

  getOperationMode(sessionId: string): SessionOperationMode {
    return cloneSessionOperationMode(this.requireSession(sessionId).operationMode);
  }

  markSetupConfirmed(sessionId: string): void {
    this.requireSession(sessionId).setupConfirmed = true;
    this.notifySessionChanged(sessionId);
  }

  isSetupConfirmed(sessionId: string): boolean {
    return this.requireSession(sessionId).setupConfirmed;
  }

  setModeId(sessionId: string, modeId: string, options?: { appendSwitchMarker?: boolean }): boolean {
    const session = this.requireSession(sessionId);
    if (session.modeId === modeId) {
      return false;
    }
    const previousModeId = session.modeId;
    session.modeId = modeId;
    session.lastActiveAt = Date.now();
    if (options?.appendSwitchMarker !== false) {
      this.historyService.appendModeSwitch(session, previousModeId, modeId);
    }
    this.notifySessionChanged(sessionId);
    return true;
  }

  setOperationMode(sessionId: string, operationMode: SessionOperationMode): SessionOperationMode {
    const session = this.requireSession(sessionId);
    setSessionOperationModeState(session, operationMode);
    this.notifySessionChanged(sessionId);
    return cloneSessionOperationMode(session.operationMode);
  }

  appendProfilePhaseTransition(
    sessionId: string,
    input: {
      target: TranscriptProfilePhaseTransitionItem["target"];
      phase: TranscriptProfilePhaseTransitionItem["phase"];
      action: TranscriptProfilePhaseTransitionItem["action"];
      source: TranscriptProfilePhaseTransitionItem["source"];
    }
  ): void {
    const session = this.requireSession(sessionId);
    this.historyService.appendProfilePhaseTransition(session, input);
    this.notifySessionChanged(sessionId);
  }

  finishProfileOperation(
    sessionId: string,
    input: {
      action: Extract<TranscriptProfilePhaseTransitionItem["action"], "exit_confirmed" | "exit_cancelled">;
      source: TranscriptProfilePhaseTransitionItem["source"];
    }
  ): boolean {
    const session = this.requireSession(sessionId);
    const profilePhase = getSessionOperationProfilePhase(session.operationMode);
    if (!profilePhase) {
      return false;
    }
    resetProfileOperationState(session);
    this.historyService.appendProfilePhaseTransition(session, {
      ...profilePhase,
      action: input.action,
      source: input.source
    });
    this.notifySessionChanged(sessionId);
    return true;
  }

  setReplyDelivery(sessionId: string, delivery: SessionDelivery): void {
    this.requireSession(sessionId).replyDelivery = delivery;
    this.notifySessionChanged(sessionId);
  }

  setSettings(
    sessionId: string,
    settings: Pick<SessionState, "pacingPreferences" | "toolsetPreferences">
  ): Pick<SessionState, "pacingPreferences" | "toolsetPreferences"> {
    const state = setSessionSettingsState(this.requireSession(sessionId), settings);
    this.notifySessionChanged(sessionId);
    return {
      pacingPreferences: {
        inputDebounce: { ...state.pacingPreferences.inputDebounce },
        oneBotOutbound: state.pacingPreferences.oneBotOutbound,
        toolLoopOutput: state.pacingPreferences.toolLoopOutput
      },
      toolsetPreferences: {
        overrides: { ...state.toolsetPreferences.overrides }
      }
    };
  }

  getPersistedSession(sessionId: string): PersistedSessionState {
    const session = this.requireSession(sessionId);
    return toPersistedSessionState(session);
  }

  restorePersistedSession(item: PersistedSessionState): SessionState {
    const existing = this.sessionStore.get(item.id);
    if (existing?.debounceTimer != null) {
      clearTimeout(existing.debounceTimer);
    }
    existing?.generationAbortController?.abort();
    existing?.responseAbortController?.abort();

    const restored = restoreSessionState(item);
    restored.historyRevision = (existing?.historyRevision ?? 0) + 1;
    restored.mutationEpoch = (existing?.mutationEpoch ?? 0) + 1;
    this.sessionStore.set(item.id, restored);
    this.notifySessionChanged(item.id);
    return restored;
  }

  getMutationEpoch(sessionId: string): number {
    return this.requireSession(sessionId).mutationEpoch;
  }

  getHistoryRevision(sessionId: string): number {
    return this.requireSession(sessionId).historyRevision;
  }

  getLastLlmUsage(sessionId: string): SessionUsageSnapshot | null {
    return this.requireSession(sessionId).lastLlmUsage;
  }

  getTaskTracker(sessionId: string): SessionTaskTracker {
    return structuredClone(this.requireSession(sessionId).taskTracker);
  }

  updateTaskTracker(
    sessionId: string,
    updater: (current: SessionTaskTracker) => SessionTaskTracker
  ): SessionTaskTracker {
    const session = this.requireSession(sessionId);
    session.taskTracker = normalizeTaskTracker(updater(structuredClone(session.taskTracker)));
    session.lastActiveAt = Date.now();
    this.notifySessionChanged(sessionId);
    return structuredClone(session.taskTracker);
  }

  setTaskTracker(sessionId: string, tracker: SessionTaskTracker): SessionTaskTracker {
    const session = this.requireSession(sessionId);
    session.taskTracker = normalizeTaskTracker(tracker);
    session.lastActiveAt = Date.now();
    this.notifySessionChanged(sessionId);
    return structuredClone(session.taskTracker);
  }

  isGenerating(sessionId: string): boolean {
    const session = this.requireSession(sessionId);
    return isSessionGenerating(session);
  }

  hasActiveResponse(sessionId: string): boolean {
    const session = this.requireSession(sessionId);
    return isSessionGenerating(session) || isSessionResponding(session);
  }

  isResponseOpen(sessionId: string, expectedResponseEpoch: number): boolean {
    const session = this.requireSession(sessionId);
    return session.responseEpoch === expectedResponseEpoch && isSessionResponding(session);
  }

  appendUserHistory(sessionId: string, message: {
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
    contentSafetyEvents?: import("./sessionTypes.ts").TranscriptContentSafetyEvent[];
  }, timestampMs = Date.now(), options?: { transcriptGroup?: "pending" | "standalone"; transcriptGroupId?: string }): void {
    const session = this.requireSession(sessionId);
    this.historyService.appendUserHistory(session, message, timestampMs, options);
    this.notifySessionChanged(sessionId);
  }

  canInsertUserHistoryByTimestamp(
    sessionId: string,
    input: {
      sourceRef?: TranscriptItemSourceRef;
      timestampMs: number;
    }
  ): boolean {
    return this.historyService.canInsertUserHistoryByTimestamp(this.requireSession(sessionId), input);
  }

  insertUserHistoryByTimestamp(sessionId: string, message: {
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
  }, timestampMs = Date.now()): boolean {
    const session = this.requireSession(sessionId);
    const inserted = this.historyService.insertUserHistoryByTimestamp(session, message, timestampMs);
    if (inserted) {
      this.notifySessionChanged(sessionId);
    }
    return inserted;
  }

  hasHistorySource(sessionId: string, sourceRef: TranscriptItemSourceRef): boolean {
    return this.historyService.hasSourceRef(this.requireSession(sessionId), sourceRef);
  }

  appendAssistantHistory(sessionId: string, message: {
    chatType: "private" | "group";
    userId: string;
    senderName: string;
    text: string;
    deliveryRef?: TranscriptItemDeliveryRef;
  }, timestampMs = Date.now()): void {
    const session = this.requireSession(sessionId);
    this.historyService.appendAssistantHistory(session, message, timestampMs);
    this.notifySessionChanged(sessionId);
  }

  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void {
    const session = this.requireSession(sessionId);
    this.historyService.appendInternalTranscript(session, item);
    this.notifySessionChanged(sessionId);
  }

  appendDebugMarker(sessionId: string, marker: SessionDebugMarker): void {
    const session = this.requireSession(sessionId);
    this.debugController.appendMarker(session, marker);
    this.notifySessionChanged(sessionId);
  }

  appendActiveAssistantResponseChunkIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    target: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
    },
    chunk: string,
    timestampMs = Date.now(),
    options?: {
      joinWithDoubleNewline?: boolean | undefined;
    }
  ): boolean {
    return this.withResponseEpoch(sessionId, expectedResponseEpoch, true, (session) => {
      appendActiveAssistantResponseChunkState(session, target, chunk, timestampMs, options);
    });
  }

  finalizeActiveAssistantResponseIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    timestampMs = Date.now()
  ): ActiveAssistantResponse | null {
    return this.withResponseEpochResult(sessionId, expectedResponseEpoch, false, null, (session) => {
      return finalizeActiveAssistantResponseState(session, timestampMs);
    });
  }

  setActiveAssistantDraftResponseIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    target: {
      chatType: "private" | "group";
      userId: string;
      senderName: string;
    },
    text: string,
    timestampMs = Date.now()
  ): boolean {
    return this.withResponseEpoch(sessionId, expectedResponseEpoch, true, (session) => {
      setActiveAssistantDraftResponseState(session, target, text, timestampMs);
    });
  }

  setLastAssistantReasoningIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    reasoningContent: string
  ): boolean {
    return this.withResponseEpoch(sessionId, expectedResponseEpoch, true, (session) => {
      this.historyService.setLastAssistantReasoning(session, reasoningContent);
    });
  }

  setLastAssistantProviderMetadataIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    providerMetadata: Record<string, unknown>
  ): boolean {
    return this.withResponseEpoch(sessionId, expectedResponseEpoch, true, (session) => {
      this.historyService.setLastAssistantProviderMetadata(session, providerMetadata);
    });
  }

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
  ): boolean {
    return this.withResponseEpochResult(sessionId, expectedResponseEpoch, true, false, (session) => (
      this.historyService.applyActiveResponseTokenStats(session, input)
    ));
  }

  clearPendingTranscriptGroup(sessionId: string): void {
    const session = this.requireSession(sessionId);
    clearPendingTranscriptGroup(session);
    this.notifySessionChanged(sessionId);
  }

  clearSession(sessionId: string): void {
    const session = this.requireSession(sessionId);
    this.clearDebounceTimer(sessionId);
    if (session.generationAbortController != null) {
      session.generationAbortController.abort();
    }
    if (session.responseAbortController != null) {
      session.responseAbortController.abort();
    }
    clearSessionState(session);
    this.notifySessionChanged(sessionId);
  }

  // Restores persisted sessions back into runtime state.
  restoreSessions(items: PersistedSessionState[]): void {
    for (const item of items) {
      this.sessionStore.set(item.id, restoreSessionState(item));
      this.notifySessionChanged(item.id);
    }
  }

  // Returns a compression snapshot when the recent window exceeds limits (message-count based).
  getHistoryForCompression(sessionId: string, triggerMessageCount: number, retainMessageCount: number): {
    historySummary: string | null;
    messagesToCompress: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    retainedMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    toolObservationsToCompress: ToolObservationSummary[];
    transcriptStartIndexToKeep: number;
  } | null {
    const session = this.requireSession(sessionId);
    return this.historyService.getHistoryForCompression(session, triggerMessageCount, retainMessageCount);
  }

  // Returns a compression snapshot when the estimated token count exceeds the trigger threshold.
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
  } | null {
    const session = this.requireSession(sessionId);
    return this.historyService.getHistoryForCompressionByTokens(
      session,
      triggerTokens,
      retainTokens,
      reportedInputTokens
    );
  }

  applyCompressedHistoryIfHistoryRevisionMatches(
    sessionId: string,
    expectedHistoryRevision: number,
    payload: {
      historySummary: string;
      transcriptStartIndexToKeep: number;
    }
  ): boolean {
    const session = this.requireSession(sessionId);
    if (session.historyRevision !== expectedHistoryRevision) {
      return false;
    }
    this.historyService.applyCompressedHistory(session, payload);
    this.notifySessionChanged(sessionId);
    return true;
  }

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
    timestampMs = Date.now()
  ): boolean {
    return this.withResponseEpoch(sessionId, expectedResponseEpoch, true, (session) => {
      this.historyService.appendAssistantHistory(session, target, timestampMs);
    });
  }

  appendInternalTranscriptIfEpochMatches(
    sessionId: string,
    expectedEpoch: number,
    item: InternalTranscriptItem
  ): boolean {
    return this.withMutationEpoch(sessionId, expectedEpoch, (session) => {
      this.historyService.appendInternalTranscript(session, item);
    });
  }

  setLastLlmUsageIfEpochMatches(sessionId: string, expectedEpoch: number, usage: SessionUsageSnapshot): boolean {
    return this.withMutationEpoch(sessionId, expectedEpoch, (session) => {
      this.historyService.setLastLlmUsage(session, usage);
    });
  }

  getSessionView(sessionId: string): {
    id: string;
    type: "private" | "group";
    source: "onebot" | "web";
    modeId: string;
    participantUserId: string;
    participantLabel: string | null;
    botProfile: SessionState["botProfile"];
    pacingPreferences: SessionState["pacingPreferences"];
    debugControl: SessionDebugControlState;
    historySummary: string | null;
    taskTracker: SessionTaskTracker;
    internalTranscript: InternalTranscriptItem[];
    debugMarkers: SessionDebugMarker[];
    lastLlmUsage: SessionUsageSnapshot | null;
    sentMessages: SessionSentMessage[];
    lastActiveAt: number;
  } {
    const session = this.requireSession(sessionId);
    return this.historyService.getSessionView(session);
  }

  getLlmVisibleHistory(sessionId: string): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }> {
    const session = this.requireSession(sessionId);
    return this.historyService.getLlmVisibleHistory(session);
  }

  getDebugControlState(sessionId: string): SessionDebugControlState {
    return this.debugController.getControlState(this.requireSession(sessionId));
  }

  getDebugMarkers(sessionId: string): SessionDebugMarker[] {
    return this.debugController.getMarkers(this.requireSession(sessionId));
  }

  setDebugEnabled(sessionId: string, enabled: boolean): SessionDebugControlState {
    const session = this.requireSession(sessionId);
    const state = this.debugController.setEnabled(session, enabled);
    this.notifySessionChanged(sessionId);
    return state;
  }

  armDebugOnce(sessionId: string): SessionDebugControlState {
    const session = this.requireSession(sessionId);
    const state = this.debugController.armOnce(session);
    this.notifySessionChanged(sessionId);
    return state;
  }

  consumeDebugMode(sessionId: string): boolean {
    return this.debugController.consume(this.requireSession(sessionId));
  }

  hasPendingInternalTriggers(sessionId: string): boolean {
    const session = this.requireSession(sessionId);
    return this.internalTriggerQueue.hasPending(session);
  }

  completeResponse(sessionId: string, expectedResponseEpoch: number): boolean {
    const session = this.requireSession(sessionId);
    const completed = this.lifecycleController.completeResponse(session, expectedResponseEpoch);
    if (completed) {
      this.notifySessionChanged(sessionId);
    }
    return completed;
  }

  recordSentMessage(sessionId: string, message: SessionSentMessage): void {
    const session = this.requireSession(sessionId);
    this.sentMessageLog.record(session, message);
    this.notifySessionChanged(sessionId);
  }

  popRetractableSentMessages(sessionId: string, count: number, maxAgeMs: number, now = Date.now()): SessionSentMessage[] {
    const session = this.requireSession(sessionId);
    return this.sentMessageLog.popRetractable(session, count, maxAgeMs, now);
  }

  excludeTranscriptItem(
    sessionId: string,
    itemId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs = Date.now()
  ): InternalTranscriptItem[] {
    const session = this.requireSession(sessionId);
    const affected = this.historyService.excludeTranscriptItem(session, itemId, reason, timestampMs);
    if (affected.length > 0) {
      this.notifySessionChanged(sessionId);
    }
    return affected;
  }

  excludeTranscriptGroup(
    sessionId: string,
    groupId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs = Date.now()
  ): InternalTranscriptItem[] {
    const session = this.requireSession(sessionId);
    const affected = this.historyService.excludeTranscriptGroup(session, groupId, reason, timestampMs);
    if (affected.length > 0) {
      this.notifySessionChanged(sessionId);
    }
    return affected;
  }

  excludeTranscriptItemsAfter(
    sessionId: string,
    itemId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs = Date.now()
  ): InternalTranscriptItem[] {
    const session = this.requireSession(sessionId);
    const affected = this.historyService.excludeTranscriptItemsAfter(session, itemId, reason, timestampMs);
    if (affected.length > 0) {
      this.notifySessionChanged(sessionId);
    }
    return affected;
  }

  reactivateTranscriptUserBatch(
    sessionId: string,
    itemId: string,
    reason: TranscriptItemRuntimeExclusionReason,
    timestampMs = Date.now()
  ): {
    messages: SessionMessage[];
    excludedItems: InternalTranscriptItem[];
    activeGroupId: string;
  } {
    const session = this.requireSession(sessionId);
    if (isSessionGenerating(session) || isSessionResponding(session) || session.pendingMessages.length > 0 || session.debounceTimer != null) {
      throw new Error("Session is busy; cannot resend a transcript message now");
    }

    const targetIndex = session.internalTranscript.findIndex((item) => item.id === itemId);
    if (targetIndex < 0) {
      throw new Error(`Transcript item not found: ${itemId}`);
    }
    const target = session.internalTranscript[targetIndex];
    if (!target || target.runtimeExcluded === true) {
      throw new Error("Transcript item is already excluded");
    }
    if (target.kind !== "user_message" && target.kind !== "user_media_message") {
      throw new Error("Only user transcript messages can be resent");
    }
    const activeGroupId = target.groupId;
    if (!activeGroupId) {
      throw new Error("Transcript item has no group id");
    }

    const userEntries = session.internalTranscript
      .map((item, index) => ({ item, index }))
      .filter((entry): entry is {
        item: TranscriptUserMessageItem | TranscriptUserMediaMessageItem;
        index: number;
      } => (
        entry.item.groupId === activeGroupId
        && entry.item.runtimeExcluded !== true
        && (entry.item.kind === "user_message" || entry.item.kind === "user_media_message")
      ));
    if (userEntries.length === 0) {
      throw new Error("Transcript user batch is empty");
    }

    const boundaryItem = userEntries[userEntries.length - 1]?.item;
    if (!boundaryItem?.id) {
      throw new Error("Transcript user batch boundary has no item id");
    }
    const excludedItems = this.historyService.excludeTranscriptItemsAfter(session, boundaryItem.id, reason, timestampMs);
    const messages = userEntries.map((entry, index) => createPendingMessageFromTranscriptUserItem(entry.item, timestampMs + index));
    session.pendingMessages = messages;
    session.pendingReplyGateWaitPasses = 0;
    session.pendingTranscriptGroupId = activeGroupId;
    session.currentReplyTarget = null;
    session.lastActiveAt = timestampMs;
    this.notifySessionChanged(sessionId);
    return { messages, excludedItems, activeGroupId };
  }

  enqueueInternalTrigger(sessionId: string, trigger: InternalSessionTriggerExecution): number {
    const session = this.requireSession(sessionId);
    const size = this.internalTriggerQueue.enqueue(session, trigger);
    this.notifySessionChanged(sessionId);
    return size;
  }

  shiftInternalTrigger(sessionId: string): InternalSessionTriggerExecution | null {
    const session = this.requireSession(sessionId);
    const trigger = this.internalTriggerQueue.shift(session);
    if (trigger) {
      this.notifySessionChanged(sessionId);
    }
    return trigger;
  }

  enqueueInlineTrigger(sessionId: string, trigger: InlineSessionTriggerExecution): number {
    const session = this.requireSession(sessionId);
    const size = this.inlineTriggerQueue.enqueue(session, trigger);
    this.notifySessionChanged(sessionId);
    return size;
  }

  hasPendingInlineTriggers(sessionId: string): boolean {
    const session = this.requireSession(sessionId);
    return this.inlineTriggerQueue.hasPending(session);
  }

  drainInlineTriggers(sessionId: string): InlineSessionTriggerExecution[] {
    const session = this.requireSession(sessionId);
    const drained = this.inlineTriggerQueue.drainAll(session);
    if (drained.length > 0) {
      this.notifySessionChanged(sessionId);
    }
    return drained;
  }

  subscribeSession(sessionId: string, listener: () => void): () => void {
    this.requireSession(sessionId);
    const listeners = this.getOrCreateSessionListeners(sessionId);
    listeners.add(listener);
    return () => {
      const activeListeners = this.sessionListeners.get(sessionId);
      if (!activeListeners) {
        return;
      }
      activeListeners.delete(listener);
      if (activeListeners.size === 0) {
        this.sessionListeners.delete(sessionId);
      }
    };
  }

  subscribeSessions(listener: () => void): () => void {
    this.allSessionListeners.add(listener);
    return () => {
      this.allSessionListeners.delete(listener);
    };
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  private getOrCreateSessionListeners(sessionId: string): Set<() => void> {
    const existing = this.sessionListeners.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Set<() => void>();
    this.sessionListeners.set(sessionId, created);
    return created;
  }

  private notifySessionChanged(sessionId: string): void {
    const listeners = this.sessionListeners.get(sessionId);
    if (listeners && listeners.size > 0) {
      for (const listener of listeners) {
        listener();
      }
    }
    if (this.allSessionListeners.size > 0) {
      for (const listener of this.allSessionListeners) {
        listener();
      }
    }
  }

  private withMutationEpoch(
    sessionId: string,
    expectedEpoch: number,
    mutate: (session: SessionState) => void
  ): boolean {
    const session = this.requireSession(sessionId);
    if (session.mutationEpoch !== expectedEpoch) {
      return false;
    }
    mutate(session);
    // Notify only after the guarded mutation is committed so stream subscribers never
    // observe a half-applied epoch-matched update.
    this.notifySessionChanged(sessionId);
    return true;
  }

  private withResponseEpoch(
    sessionId: string,
    expectedResponseEpoch: number,
    requireResponding: boolean,
    mutate: (session: SessionState) => void
  ): boolean {
    return this.withResponseEpochResult(sessionId, expectedResponseEpoch, requireResponding, false, (session) => {
      mutate(session);
      return true;
    });
  }

  private withResponseEpochResult<T>(
    sessionId: string,
    expectedResponseEpoch: number,
    requireResponding: boolean,
    fallback: T,
    mutate: (session: SessionState) => T
  ): T {
    const session = this.requireSession(sessionId);
    const responseEpochMatched = session.responseEpoch === expectedResponseEpoch;
    if (!responseEpochMatched || (requireResponding && !isSessionResponding(session))) {
      return fallback;
    }
    const result = mutate(session);
    // Response-scoped writes share the same post-commit notification rule as mutation-epoch
    // writes: listeners should only re-read session state after the invariant has succeeded.
    this.notifySessionChanged(sessionId);
    return result;
  }
}

function createPendingMessageFromTranscriptUserItem(
  item: TranscriptUserMessageItem | TranscriptUserMediaMessageItem,
  receivedAt: number
): SessionMessage {
  const contentParts = [...(item.contentParts ?? [])];
  const audioParts = contentParts.filter((part) => part.kind === "audio");
  return {
    chatType: item.chatType,
    userId: item.userId,
    senderName: item.senderName,
    text: item.kind === "user_message" ? item.text : "",
    ...(contentParts.length > 0 ? { contentParts } : {}),
    images: [],
    audioSources: audioParts.map((part) => part.source).filter((value): value is string => Boolean(value)),
    audioIds: audioParts.map((part) => part.audioId).filter((value): value is string => Boolean(value)),
    emojiSources: [],
    imageIds: [...item.imageIds],
    emojiIds: [...item.emojiIds],
    attachments: [...(item.attachments ?? [])],
    messageFiles: item.kind === "user_message" ? [...item.messageFiles] : [],
    specialSegments: item.kind === "user_message" && item.specialSegments ? [...item.specialSegments] : [],
    forwardIds: item.kind === "user_message" ? [...item.forwardIds] : [],
    replyMessageId: item.replyMessageId,
    mentionUserIds: [...item.mentionUserIds],
    mentionedAll: item.mentionedAll,
    isAtMentioned: item.mentionedSelf,
    receivedAt
  };
}
