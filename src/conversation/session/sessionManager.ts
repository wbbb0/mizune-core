import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { AppConfig } from "#config/config.ts";
import {
  beginGenerationState,
  beginSyntheticGenerationState,
  cancelGenerationState,
  completeResponseState,
  finishGenerationState,
  interruptResponseState
} from "./sessionLifecycle.ts";
import {
  appendDebugMarkerState,
  appendHistoryEntry,
  appendInternalTranscriptState,
  appendActiveAssistantResponseChunkState,
  appendSessionMessage,
  appendSteerMessageState,
  applyCompressedHistoryState,
  appendToolEventState,
  clearSessionState,
  consumeSteerMessagesState,
  enqueueInternalTriggerState,
  finalizeActiveAssistantResponseState,
  popRetractableSentMessagesState,
  promoteSteerMessagesToPendingState,
  recordSentMessageState,
  requeuePendingMessagesState,
  setSessionDebugControlState,
  setInterruptibleGroupTriggerUserState,
  setLastLlmUsageState,
  shiftInternalTriggerState
} from "./sessionMutations.ts";
import {
  cloneSessionState,
  getHistoryForCompressionSnapshot,
  getSessionViewSnapshot
} from "./sessionQueries.ts";
import { projectLlmVisibleHistoryFromTranscript, projectVisibleMessagesFromTranscript } from "./sessionTranscript.ts";
import {
  createAssistantTranscriptMessageItem,
  createUserTranscriptMessageItem
} from "./historyContext.ts";
import {
  buildSessionId,
  createSessionState,
  restoreSessionState,
  toPersistedSessionState
} from "./sessionStateFactory.ts";
import type {
  ActiveAssistantResponse,
  DebugLiteral,
  InternalSessionTriggerExecution,
  InternalTranscriptItem,
  PersistedSessionState,
  SessionDelivery,
  SessionDebugMarker,
  SessionDebugControlState,
  SessionMessage,
  SessionSentMessage,
  SessionState,
  SessionToolEvent,
  SessionUsageSnapshot
} from "./sessionTypes.ts";

export type {
  ActiveAssistantResponse,
  DebugLiteral,
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
  SessionToolEvent,
  SessionUsageSnapshot
} from "./sessionTypes.ts";

// Owns the runtime session map and exposes the public session mutation API.
export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly config: AppConfig) { }

  // Returns the existing session for an incoming message or creates a new one.
  getOrCreateSession(message: ParsedIncomingMessage): SessionState {
    const sessionId = buildSessionId(message);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const created = createSessionState({
      id: sessionId,
      type: message.chatType
    });
    this.sessions.set(sessionId, created);
    return created;
  }

  appendPendingMessage(sessionId: string, message: ParsedIncomingMessage): SessionState {
    const session = this.requireSession(sessionId);
    return appendSessionMessage(session, message);
  }

  appendSteerMessage(sessionId: string, message: ParsedIncomingMessage): SessionState {
    const session = this.requireSession(sessionId);
    return appendSteerMessageState(session, message);
  }

  // Ensures a session exists for a known target id and type.
  ensureSession(target: {
    id: string;
    type: "private" | "group";
  }): SessionState {
    const existing = this.sessions.get(target.id);
    if (existing) {
      return existing;
    }

    const created = createSessionState(target);
    this.sessions.set(target.id, created);
    return created;
  }

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
  ): SessionState {
    const session = this.requireSession(sessionId);
    return appendSessionMessage(session, {
      ...message,
      audioSources: message.audioSources ?? [],
      audioIds: message.audioIds ?? [],
      emojiSources: message.emojiSources ?? [],
      imageIds: message.imageIds ?? [],
      emojiIds: message.emojiIds ?? [],
      attachments: message.attachments ?? [],
      forwardIds: message.forwardIds ?? [],
      replyMessageId: message.replyMessageId ?? null,
      mentionUserIds: message.mentionUserIds ?? [],
      mentionedAll: message.mentionedAll ?? false,
      isAtMentioned: message.isAtMentioned ?? false
    });
  }

  consumeSteerMessages(sessionId: string): SessionMessage[] {
    const session = this.requireSession(sessionId);
    return consumeSteerMessagesState(session);
  }

  hasPendingSteerMessages(sessionId: string): boolean {
    return this.requireSession(sessionId).pendingSteerMessages.length > 0;
  }

  promoteSteerMessagesToPending(sessionId: string): number {
    const session = this.requireSession(sessionId);
    return promoteSteerMessagesToPendingState(session);
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
    return beginGenerationState(session);
  }

  // Starts a synthetic generation cycle without consuming pending messages.
  beginSyntheticGeneration(sessionId: string): {
    session: SessionState;
    abortController: AbortController;
    responseAbortController: AbortController;
    responseEpoch: number;
  } {
    const session = this.requireSession(sessionId);
    return beginSyntheticGenerationState(session);
  }

  // Marks the active generation as finished if the abort controller still matches.
  finishGeneration(sessionId: string, abortController: AbortController): boolean {
    const session = this.requireSession(sessionId);
    return finishGenerationState(session, abortController);
  }

  // Cancels the current generation request for a session.
  cancelGeneration(sessionId: string): boolean {
    const session = this.requireSession(sessionId);
    return cancelGenerationState(session);
  }

  // Aborts the outbound message queue for a session without cancelling generation.
  // Queued messages that have not been sent yet will be skipped.
  // Generation and tool execution continue running.
  interruptOutbound(sessionId: string): boolean {
    const session = this.requireSession(sessionId);
    if (session.responseAbortController == null || session.responseAbortController.signal.aborted) {
      return false;
    }
    session.responseAbortController.abort();
    return true;
  }

  // Interrupts both generation and outbound response work for a session.
  interruptResponse(sessionId: string): {
    cancelledGeneration: boolean;
    cancelledOutbound: boolean;
    finalizedAssistant: boolean;
  } {
    const session = this.requireSession(sessionId);
    const finalizedAssistant = finalizeActiveAssistantResponseState(session, Date.now());
    const interrupted = interruptResponseState(session);
    return {
      ...interrupted,
      finalizedAssistant: finalizedAssistant != null
    };
  }

  setDebounceTimer(sessionId: string, timer: NodeJS.Timeout): void {
    const session = this.requireSession(sessionId);
    session.debounceTimer = timer;
  }

  clearDebounceTimer(sessionId: string): void {
    const session = this.requireSession(sessionId);
    if (session.debounceTimer != null) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = null;
    }
  }

  // Requeues pending messages after a reply-gate wait decision.
  requeuePendingMessages(sessionId: string, messages: SessionMessage[], replyGateWaitPasses: number): void {
    if (messages.length === 0) {
      return;
    }
    const session = this.requireSession(sessionId);
    requeuePendingMessagesState(session, messages, replyGateWaitPasses);
  }

  listSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map((session) => cloneSessionState(session));
  }

  getSession(sessionId: string): SessionState {
    return this.requireSession(sessionId);
  }

  getLastInboundDelivery(sessionId: string): SessionDelivery {
    return this.requireSession(sessionId).lastInboundDelivery;
  }

  setLastInboundDelivery(sessionId: string, delivery: SessionDelivery): void {
    this.requireSession(sessionId).lastInboundDelivery = delivery;
  }

  getPersistedSession(sessionId: string): PersistedSessionState {
    const session = this.requireSession(sessionId);
    return toPersistedSessionState(session);
  }

  getMutationEpoch(sessionId: string): number {
    return this.requireSession(sessionId).mutationEpoch;
  }

  getHistoryRevision(sessionId: string): number {
    return this.requireSession(sessionId).historyRevision;
  }

  hasActiveResponse(sessionId: string): boolean {
    const session = this.requireSession(sessionId);
    return session.isGenerating || session.isResponding;
  }

  isResponseOpen(sessionId: string, expectedResponseEpoch: number): boolean {
    const session = this.requireSession(sessionId);
    return session.responseEpoch === expectedResponseEpoch && session.isResponding;
  }

  appendHistory(sessionId: string, role: "user" | "assistant", content: string, timestampMs = Date.now()): void {
    const session = this.requireSession(sessionId);
    const defaultUserId = session.type === "private"
      ? session.id.slice("private:".length)
      : "unknown";
    if (role === "user") {
      appendHistoryEntry(session, createUserTranscriptMessageItem({
        chatType: session.type,
        userId: defaultUserId,
        senderName: defaultUserId,
        text: content,
        timestampMs
      }));
      return;
    }
    appendHistoryEntry(session, createAssistantTranscriptMessageItem({
      chatType: session.type,
      userId: defaultUserId,
      senderName: defaultUserId,
      text: content,
      timestampMs
    }));
  }

  appendUserHistory(sessionId: string, message: {
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
  }, timestampMs = Date.now()): void {
    const session = this.requireSession(sessionId);
    appendHistoryEntry(session, createUserTranscriptMessageItem({
      chatType: message.chatType,
      userId: message.userId,
      senderName: message.senderName,
      text: message.text,
      ...(message.imageIds ? { imageIds: message.imageIds } : {}),
      ...(message.emojiIds ? { emojiIds: message.emojiIds } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
      ...(message.audioCount != null ? { audioCount: message.audioCount } : {}),
      ...(message.forwardIds ? { forwardIds: message.forwardIds } : {}),
      ...(message.replyMessageId !== undefined ? { replyMessageId: message.replyMessageId } : {}),
      ...(message.mentionUserIds ? { mentionUserIds: message.mentionUserIds } : {}),
      ...(message.mentionedAll !== undefined ? { mentionedAll: message.mentionedAll } : {}),
      ...(message.mentionedSelf !== undefined ? { mentionedSelf: message.mentionedSelf } : {}),
      timestampMs
    }));
  }

  appendAssistantHistory(sessionId: string, message: {
    chatType: "private" | "group";
    userId: string;
    senderName: string;
    text: string;
  }, timestampMs = Date.now()): void {
    const session = this.requireSession(sessionId);
    appendHistoryEntry(session, createAssistantTranscriptMessageItem({
      ...message,
      timestampMs
    }));
  }

  appendInternalTranscript(sessionId: string, item: InternalTranscriptItem): void {
    const session = this.requireSession(sessionId);
    appendInternalTranscriptState(session, item);
  }

  appendDebugMarker(sessionId: string, marker: SessionDebugMarker): void {
    const session = this.requireSession(sessionId);
    appendDebugMarkerState(session, marker);
  }

  appendToolEvent(sessionId: string, event: SessionToolEvent): void {
    const session = this.requireSession(sessionId);
    appendToolEventState(session, event);
  }

  setLastLlmUsage(sessionId: string, usage: SessionUsageSnapshot): void {
    const session = this.requireSession(sessionId);
    setLastLlmUsageState(session, usage);
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
    const session = this.requireSession(sessionId);
    if (session.responseEpoch !== expectedResponseEpoch || !session.isResponding) {
      return false;
    }
    appendActiveAssistantResponseChunkState(session, target, chunk, timestampMs, options);
    return true;
  }

  finalizeActiveAssistantResponseIfResponseEpochMatches(
    sessionId: string,
    expectedResponseEpoch: number,
    timestampMs = Date.now()
  ): ActiveAssistantResponse | null {
    const session = this.requireSession(sessionId);
    if (session.responseEpoch !== expectedResponseEpoch) {
      return null;
    }
    return finalizeActiveAssistantResponseState(session, timestampMs);
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
  }

  // Restores persisted sessions back into runtime state.
  restoreSessions(items: PersistedSessionState[]): void {
    for (const item of items) {
      this.sessions.set(item.id, restoreSessionState(item));
    }
  }

  // Returns a compression snapshot when the recent window exceeds limits.
  getHistoryForCompression(sessionId: string, triggerMessageCount: number, retainMessageCount: number): {
    historySummary: string | null;
    messagesToCompress: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    retainedMessages: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>;
    transcriptStartIndexToKeep: number;
  } | null {
    const session = this.requireSession(sessionId);
    return getHistoryForCompressionSnapshot(session, this.config, triggerMessageCount, retainMessageCount);
  }

  applyCompressedHistory(
    sessionId: string,
    payload: {
      historySummary: string;
      transcriptStartIndexToKeep: number;
    }
  ): void {
    const session = this.requireSession(sessionId);
    applyCompressedHistoryState(session, payload);
  }

  applyCompressedHistoryIfEpochMatches(
    sessionId: string,
    expectedEpoch: number,
    payload: {
      historySummary: string;
      transcriptStartIndexToKeep: number;
    }
  ): boolean {
    const session = this.requireSession(sessionId);
    if (session.mutationEpoch !== expectedEpoch) {
      return false;
    }
    applyCompressedHistoryState(session, payload);
    return true;
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
    applyCompressedHistoryState(session, payload);
    return true;
  }

  appendHistoryIfEpochMatches(
    sessionId: string,
    expectedEpoch: number,
    role: "user" | "assistant",
    content: string,
    timestampMs = Date.now()
  ): boolean {
    const session = this.requireSession(sessionId);
    if (session.mutationEpoch !== expectedEpoch) {
      return false;
    }
    const defaultUserId = session.type === "private"
      ? session.id.slice("private:".length)
      : "unknown";
    appendHistoryEntry(session, role === "user"
      ? createUserTranscriptMessageItem({
          chatType: session.type,
          userId: defaultUserId,
          senderName: defaultUserId,
          text: content,
          timestampMs
        })
      : createAssistantTranscriptMessageItem({
          chatType: session.type,
          userId: defaultUserId,
          senderName: defaultUserId,
          text: content,
          timestampMs
        }));
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
    },
    timestampMs = Date.now()
  ): boolean {
    const session = this.requireSession(sessionId);
    if (session.responseEpoch !== expectedResponseEpoch || !session.isResponding) {
      return false;
    }
    appendHistoryEntry(session, createAssistantTranscriptMessageItem({
      ...target,
      timestampMs
    }));
    return true;
  }

  appendInternalTranscriptIfEpochMatches(
    sessionId: string,
    expectedEpoch: number,
    item: InternalTranscriptItem
  ): boolean {
    const session = this.requireSession(sessionId);
    if (session.mutationEpoch !== expectedEpoch) {
      return false;
    }
    appendInternalTranscriptState(session, item);
    return true;
  }

  appendDebugMarkerIfEpochMatches(
    sessionId: string,
    expectedEpoch: number,
    marker: SessionDebugMarker
  ): boolean {
    const session = this.requireSession(sessionId);
    if (session.mutationEpoch !== expectedEpoch) {
      return false;
    }
    appendDebugMarkerState(session, marker);
    return true;
  }

  appendToolEventIfEpochMatches(
    sessionId: string,
    expectedEpoch: number,
    event: SessionToolEvent
  ): boolean {
    const session = this.requireSession(sessionId);
    if (session.mutationEpoch !== expectedEpoch) {
      return false;
    }
    appendToolEventState(session, event);
    return true;
  }

  setLastLlmUsageIfEpochMatches(sessionId: string, expectedEpoch: number, usage: SessionUsageSnapshot): boolean {
    const session = this.requireSession(sessionId);
    if (session.mutationEpoch !== expectedEpoch) {
      return false;
    }
    setLastLlmUsageState(session, usage);
    return true;
  }

  getSessionView(sessionId: string): {
    id: string;
    type: "private" | "group";
    debugControl: SessionDebugControlState;
    historySummary: string | null;
    internalTranscript: InternalTranscriptItem[];
    debugMarkers: SessionDebugMarker[];
    recentToolEvents: SessionToolEvent[];
    lastLlmUsage: SessionUsageSnapshot | null;
    sentMessages: SessionSentMessage[];
    lastActiveAt: number;
  } {
    const session = this.requireSession(sessionId);
    return getSessionViewSnapshot(session);
  }

  getLlmVisibleHistory(sessionId: string): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }> {
    const session = this.requireSession(sessionId);
    return projectLlmVisibleHistoryFromTranscript(session.internalTranscript, this.config);
  }

  getVisibleChatMessages(sessionId: string): Array<{ role: "user" | "assistant"; content: string; timestampMs: number }> {
    const session = this.requireSession(sessionId);
    return projectVisibleMessagesFromTranscript(session.internalTranscript);
  }

  getDebugControlState(sessionId: string): SessionDebugControlState {
    return { ...this.requireSession(sessionId).debugControl };
  }

  getDebugMarkers(sessionId: string): SessionDebugMarker[] {
    return [...this.requireSession(sessionId).debugMarkers];
  }

  setDebugEnabled(sessionId: string, enabled: boolean): SessionDebugControlState {
    const session = this.requireSession(sessionId);
    return setSessionDebugControlState(session, {
      enabled,
      ...(enabled ? {} : { oncePending: false })
    });
  }

  armDebugOnce(sessionId: string): SessionDebugControlState {
    const session = this.requireSession(sessionId);
    return setSessionDebugControlState(session, { oncePending: true });
  }

  consumeDebugMode(sessionId: string): boolean {
    const session = this.requireSession(sessionId);
    const active = session.debugControl.enabled || session.debugControl.oncePending;
    if (session.debugControl.oncePending) {
      setSessionDebugControlState(session, { oncePending: false });
    }
    return active;
  }

  setInterruptibleGroupTriggerUser(sessionId: string, userId: string | null): void {
    const session = this.requireSession(sessionId);
    setInterruptibleGroupTriggerUserState(session, userId);
  }

  matchesInterruptibleGroupTriggerUser(sessionId: string, userId: string): boolean {
    const session = this.requireSession(sessionId);
    return session.interruptibleGroupTriggerUserId != null && session.interruptibleGroupTriggerUserId === userId;
  }

  completeResponse(sessionId: string, expectedResponseEpoch: number): boolean {
    const session = this.requireSession(sessionId);
    return completeResponseState(session, expectedResponseEpoch);
  }

  recordSentMessage(sessionId: string, message: SessionSentMessage): void {
    const session = this.requireSession(sessionId);
    recordSentMessageState(session, message);
  }

  popRetractableSentMessages(sessionId: string, count: number, maxAgeMs: number, now = Date.now()): SessionSentMessage[] {
    const session = this.requireSession(sessionId);
    return popRetractableSentMessagesState(session, count, maxAgeMs, now);
  }

  enqueueInternalTrigger(sessionId: string, trigger: InternalSessionTriggerExecution): number {
    const session = this.requireSession(sessionId);
    return enqueueInternalTriggerState(session, trigger);
  }

  shiftInternalTrigger(sessionId: string): InternalSessionTriggerExecution | null {
    const session = this.requireSession(sessionId);
    return shiftInternalTriggerState(session);
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }
}
