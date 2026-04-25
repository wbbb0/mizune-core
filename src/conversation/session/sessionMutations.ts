import type { OneBotMessageEvent } from "#services/onebot/types.ts";
import type {
  ActiveAssistantResponse,
  InternalSessionTriggerExecution,
  InternalTranscriptItem,
  SessionDebugMarker,
  SessionDebugControlState,
  SessionMessage,
  SessionSentMessage,
  SessionState,
  SessionPhase,
  SessionToolEvent,
  TranscriptAssistantMessageItem,
  TranscriptUserMessageItem,
  SessionUsageSnapshot
} from "./sessionTypes.ts";
import {
  cloneSessionOperationMode,
  createNormalSessionOperationMode,
  type SessionOperationMode
} from "./sessionOperationMode.ts";

const MAX_RECENT_TOOL_EVENTS = 12;
const MAX_INTERNAL_TRANSCRIPT_ITEMS = 160;
const MAX_DEBUG_MARKERS = 24;

function updateSessionMessageTiming(session: SessionState, now: number): void {
  if (session.lastMessageAt != null) {
    const gapMs = Math.max(0, now - session.lastMessageAt);
    session.latestGapMs = gapMs;
  }
  session.lastActiveAt = now;
  session.lastMessageAt = now;
}

function createSessionMessage(
  message: {
    chatType: "private" | "group";
    userId: string;
    groupId?: string;
    senderName: string;
    text: string;
    images: string[];
    audioSources: string[];
    audioIds: string[];
    emojiSources: string[];
    imageIds: string[];
    emojiIds: string[];
    attachments?: SessionMessage["attachments"];
    forwardIds: string[];
    replyMessageId: string | null;
    mentionUserIds: string[];
    mentionedAll: boolean;
    isAtMentioned: boolean;
    rawEvent?: OneBotMessageEvent | undefined;
  },
  receivedAt: number
): SessionMessage {
  const pendingMessage: SessionMessage = {
    userId: message.userId,
    ...(message.groupId ? { groupId: message.groupId } : {}),
    senderName: message.senderName,
    chatType: message.chatType,
    text: message.text,
    images: [...message.images],
    audioSources: [...(message.audioSources ?? [])],
    audioIds: [...(message.audioIds ?? [])],
    emojiSources: [...(message.emojiSources ?? [])],
    imageIds: [...message.imageIds],
    emojiIds: [...(message.emojiIds ?? [])],
    attachments: [...(message.attachments ?? [])],
    forwardIds: [...(message.forwardIds ?? [])],
    replyMessageId: message.replyMessageId ?? null,
    mentionUserIds: [...(message.mentionUserIds ?? [])],
    mentionedAll: message.mentionedAll ?? false,
    isAtMentioned: message.isAtMentioned ?? false,
    receivedAt
  };
  if (message.rawEvent != null) {
    pendingMessage.rawEvent = message.rawEvent;
  }
  return pendingMessage;
}

// Applies stateful session mutations for messages, history, tasks, and timers.
export function appendSessionMessage(
  session: SessionState,
  message: {
    chatType: "private" | "group";
    userId: string;
    groupId?: string;
    senderName: string;
    text: string;
    images: string[];
    audioSources: string[];
    audioIds: string[];
    emojiSources: string[];
    imageIds: string[];
    emojiIds: string[];
    attachments?: SessionMessage["attachments"];
    forwardIds: string[];
    replyMessageId: string | null;
    mentionUserIds: string[];
    mentionedAll: boolean;
    isAtMentioned: boolean;
    rawEvent?: OneBotMessageEvent | undefined;
  }
): SessionState {
  const now = Date.now();
  session.pendingMessages.push(createSessionMessage(message, now));
  session.pendingReplyGateWaitPasses = 0;
  updateSessionMessageTiming(session, now);
  return session;
}

export function appendSteerMessageState(
  session: SessionState,
  message: {
    chatType: "private" | "group";
    userId: string;
    groupId?: string;
    senderName: string;
    text: string;
    images: string[];
    audioSources: string[];
    audioIds: string[];
    emojiSources: string[];
    imageIds: string[];
    emojiIds: string[];
    attachments?: SessionMessage["attachments"];
    forwardIds: string[];
    replyMessageId: string | null;
    mentionUserIds: string[];
    mentionedAll: boolean;
    isAtMentioned: boolean;
    rawEvent?: OneBotMessageEvent | undefined;
  }
): SessionState {
  const now = Date.now();
  session.pendingSteerMessages.push(createSessionMessage(message, now));
  updateSessionMessageTiming(session, now);
  return session;
}

export function consumeSteerMessagesState(session: SessionState): SessionMessage[] {
  if (session.pendingSteerMessages.length === 0) {
    return [];
  }
  const messages = [...session.pendingSteerMessages];
  session.pendingSteerMessages = [];
  session.lastActiveAt = Date.now();
  return messages;
}

export function promoteSteerMessagesToPendingState(session: SessionState): number {
  if (session.pendingSteerMessages.length === 0) {
    return 0;
  }
  const promoted = [...session.pendingSteerMessages];
  session.pendingSteerMessages = [];
  session.pendingMessages = [...promoted, ...session.pendingMessages];
  session.pendingReplyGateWaitPasses = 0;
  session.lastActiveAt = Date.now();
  return promoted.length;
}

// Appends a history entry and reapplies the configured history window.
export function appendHistoryEntry(
  session: SessionState,
  item: InternalTranscriptItem
): void {
  appendInternalTranscriptState(session, item);
  session.historyRevision += 1;
}

// Applies compressed history payload and normalizes the resulting window.
export function applyCompressedHistoryState(
  session: SessionState,
  payload: {
    historySummary: string;
    transcriptStartIndexToKeep: number;
  }
): void {
  session.historySummary = payload.historySummary;
  session.internalTranscript = session.internalTranscript.slice(
    Math.max(0, Math.min(payload.transcriptStartIndexToKeep, session.internalTranscript.length))
  );
  // Provider usage describes the prompt before compression; discard it so the
  // next compression check does not reuse stale input token counts.
  session.lastLlmUsage = null;
  session.historyRevision += 1;
}

export function appendToolEventState(session: SessionState, event: SessionToolEvent): void {
  session.recentToolEvents.push(event);
  if (session.recentToolEvents.length > MAX_RECENT_TOOL_EVENTS) {
    session.recentToolEvents = session.recentToolEvents.slice(-MAX_RECENT_TOOL_EVENTS);
  }
  session.historyRevision += 1;
}

export function appendInternalTranscriptState(session: SessionState, item: InternalTranscriptItem): void {
  session.internalTranscript.push(item);
  if (session.internalTranscript.length > MAX_INTERNAL_TRANSCRIPT_ITEMS) {
    session.internalTranscript = session.internalTranscript.slice(-MAX_INTERNAL_TRANSCRIPT_ITEMS);
  }
}

export function setLastAssistantMessageReasoningState(session: SessionState, reasoningContent: string): boolean {
  for (let i = session.internalTranscript.length - 1; i >= 0; i--) {
    const item = session.internalTranscript[i];
    if (item?.kind === "assistant_message") {
      item.reasoningContent = reasoningContent;
      return true;
    }
  }
  return false;
}

export function appendDebugMarkerState(session: SessionState, marker: SessionDebugMarker): void {
  session.debugMarkers.push(marker);
  if (session.debugMarkers.length > MAX_DEBUG_MARKERS) {
    session.debugMarkers = session.debugMarkers.slice(-MAX_DEBUG_MARKERS);
  }
  appendInternalTranscriptState(session, {
    kind: "system_marker",
    llmVisible: false,
    markerType: marker.kind,
    content: marker.note ?? marker.kind,
    timestampMs: marker.timestampMs
  });
}

// Clears the mutable runtime state for a session.
export function clearSessionState(session: SessionState): void {
  session.mutationEpoch += 1;
  session.historyRevision += 1;
  session.operationMode = createNormalSessionOperationMode();
  session.setupConfirmed = false;
  session.pendingMessages = [];
  session.pendingSteerMessages = [];
  session.pendingReplyGateWaitPasses = 0;
  session.pendingTranscriptGroupId = null;
  session.activeTranscriptGroupId = null;
  session.pendingInternalTriggers = [];
  session.interruptibleGroupTriggerUserId = null;
  session.historySummary = null;
  session.internalTranscript = [];
  session.debugMarkers = [];
  session.recentToolEvents = [];
  session.lastLlmUsage = null;
  session.sentMessages = [];
  session.phase = { kind: "idle" };
  session.messageQueue = [];
  session.lastActiveAt = Date.now();
  session.lastMessageAt = null;
  session.latestGapMs = null;
  session.smoothedGapMs = null;
  session.generationAbortController = null;
  session.responseAbortController = null;
  session.activeAssistantResponse = null;
  session.activeAssistantDraftResponse = null;
}

export function setSessionOperationModeState(session: SessionState, operationMode: SessionOperationMode): void {
  session.operationMode = cloneSessionOperationMode(operationMode);
  session.lastActiveAt = Date.now();
}

export function setSessionPhaseState(session: SessionState, phase: SessionPhase): void {
  session.phase = phase;
}

export function setSessionDebugControlState(
  session: SessionState,
  next: Partial<SessionDebugControlState>
): SessionDebugControlState {
  session.debugControl = {
    ...session.debugControl,
    ...next
  };
  session.lastActiveAt = Date.now();
  return session.debugControl;
}

export function appendActiveAssistantResponseChunkState(
  session: SessionState,
  target: {
    chatType: "private" | "group";
    userId: string;
    senderName: string;
  },
  chunk: string,
  timestampMs: number,
  options?: {
    joinWithDoubleNewline?: boolean | undefined;
  }
): ActiveAssistantResponse {
  const existing = session.activeAssistantResponse;
  if (
    existing == null
    || existing.chatType !== target.chatType
    || existing.userId !== target.userId
    || existing.senderName !== target.senderName
  ) {
    session.activeAssistantResponse = {
      chatType: target.chatType,
      userId: target.userId,
      senderName: target.senderName,
      text: chunk,
      startedAt: timestampMs,
      lastUpdatedAt: timestampMs
    };
    return session.activeAssistantResponse;
  }

  existing.text += options?.joinWithDoubleNewline
    ? `\n\n${chunk}`
    : chunk;
  existing.lastUpdatedAt = timestampMs;
  return existing;
}

export function finalizeActiveAssistantResponseState(
  session: SessionState,
  timestampMs: number
): ActiveAssistantResponse | null {
  const active = session.activeAssistantResponse;
  session.activeAssistantResponse = null;
  if (active == null || !active.text.trim()) {
    return null;
  }
  return active;
}

export function setActiveAssistantDraftResponseState(
  session: SessionState,
  target: {
    chatType: "private" | "group";
    userId: string;
    senderName: string;
  },
  text: string,
  timestampMs: number
): ActiveAssistantResponse | null {
  const normalizedText = String(text ?? "");
  if (!normalizedText.trim()) {
    session.activeAssistantDraftResponse = null;
    return null;
  }

  const existing = session.activeAssistantDraftResponse;
  if (
    existing == null
    || existing.chatType !== target.chatType
    || existing.userId !== target.userId
    || existing.senderName !== target.senderName
  ) {
    session.activeAssistantDraftResponse = {
      chatType: target.chatType,
      userId: target.userId,
      senderName: target.senderName,
      text: normalizedText,
      startedAt: timestampMs,
      lastUpdatedAt: timestampMs
    };
    return session.activeAssistantDraftResponse;
  }

  existing.text = normalizedText;
  existing.lastUpdatedAt = timestampMs;
  return existing;
}

export function finalizeActiveAssistantDraftResponseState(
  session: SessionState
): ActiveAssistantResponse | null {
  const active = session.activeAssistantDraftResponse;
  session.activeAssistantDraftResponse = null;
  if (active == null || !active.text.trim()) {
    return null;
  }
  return active;
}

// Requeues pending messages after a deferral decision.
export function requeuePendingMessagesState(
  session: SessionState,
  messages: SessionMessage[],
  replyGateWaitPasses: number
): void {
  session.pendingMessages = [...messages, ...session.pendingMessages];
  session.pendingReplyGateWaitPasses = Math.max(session.pendingReplyGateWaitPasses, replyGateWaitPasses);
  session.lastActiveAt = Date.now();
}

// Records the latest provider usage snapshot for the session.
export function setLastLlmUsageState(session: SessionState, usage: SessionUsageSnapshot): void {
  session.lastLlmUsage = usage;
}

// Tracks an outbound message for later retract or view operations.
export function recordSentMessageState(session: SessionState, message: SessionSentMessage): void {
  session.sentMessages.push(message);
  if (session.sentMessages.length > 50) {
    session.sentMessages = session.sentMessages.slice(-50);
  }
}

// Pops recent retractable outbound messages while preserving the rest.
export function popRetractableSentMessagesState(
  session: SessionState,
  count: number,
  maxAgeMs: number,
  now: number
): SessionSentMessage[] {
  const selected: SessionSentMessage[] = [];
  const retained: SessionSentMessage[] = [];

  for (let index = session.sentMessages.length - 1; index >= 0; index -= 1) {
    const item = session.sentMessages[index];
    if (!item) {
      continue;
    }
    if (selected.length < count && now - item.sentAt <= maxAgeMs) {
      selected.push(item);
      continue;
    }
    retained.unshift(item);
  }

  session.sentMessages = retained;
  return selected;
}

// Appends an internal trigger to the session queue.
export function enqueueInternalTriggerState(session: SessionState, trigger: InternalSessionTriggerExecution): number {
  session.pendingInternalTriggers.push(trigger);
  session.lastActiveAt = Date.now();
  return session.pendingInternalTriggers.length;
}

// Removes the next internal trigger from the session queue.
export function shiftInternalTriggerState(session: SessionState): InternalSessionTriggerExecution | null {
  return session.pendingInternalTriggers.shift() ?? null;
}

// Updates which group user can currently interrupt the session response.
export function setInterruptibleGroupTriggerUserState(session: SessionState, userId: string | null): void {
  session.interruptibleGroupTriggerUserId = userId;
}
