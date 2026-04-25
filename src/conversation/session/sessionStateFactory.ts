import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import { getDefaultSessionModeId } from "#modes/registry.ts";
import type { SessionParticipantRef, SessionState, PersistedSessionState, SessionTitleSource } from "./sessionTypes.ts";
import {
  cloneSessionOperationMode,
  createNormalSessionOperationMode
} from "./sessionOperationMode.ts";
import {
  buildSessionId,
  getSessionSource,
  resolveSessionParticipantRef
} from "./sessionIdentity.ts";
import { resolveSessionDefaultTitle } from "./sessionTitle.ts";
import { normalizeTranscriptItems } from "./transcriptMetadata.ts";

// Creates and converts runtime session state snapshots.

// Builds an empty in-memory session state for a target conversation.
export function createSessionState(target: {
  id: string;
  type: "private" | "group";
  source?: "onebot" | "web";
  participantRef?: SessionParticipantRef;
  title?: string | null;
  titleSource?: SessionTitleSource | null;
}): SessionState {
  const modeId = getDefaultSessionModeId();
  const participantRef = target.participantRef ?? resolveSessionParticipantRef({
    sessionId: target.id,
    type: target.type
  });
  const normalizedTitle = String(target.title ?? "").trim();
  const source = target.source ?? getSessionSource(target.id);
  return {
    id: target.id,
    type: target.type,
    source,
    modeId,
    operationMode: createNormalSessionOperationMode(),
    setupConfirmed: false,
    participantRef,
    title: normalizedTitle || resolveSessionDefaultTitle({
      source,
      type: target.type,
      id: target.id,
      modeId,
      participantRef
    }),
    titleSource: target.titleSource ?? (normalizedTitle ? "manual" : "default"),
    replyDelivery: source,
    debugControl: {
      enabled: false,
      oncePending: false
    },
    pendingMessages: [],
    pendingSteerMessages: [],
    pendingReplyGateWaitPasses: 0,
    pendingTranscriptGroupId: null,
    activeTranscriptGroupId: null,
    pendingInternalTriggers: [],
    interruptibleGroupTriggerUserId: null,
    historySummary: null,
    internalTranscript: [],
    debugMarkers: [],
    recentToolEvents: [],
    lastLlmUsage: null,
    sentMessages: [],
    phase: { kind: "idle" },
    responseEpoch: 0,
    messageQueue: [],
    lastActiveAt: Date.now(),
    lastMessageAt: null,
    latestGapMs: null,
    smoothedGapMs: null,
    historyRevision: 0,
    mutationEpoch: 0,
    debounceTimer: null,
    generationAbortController: null,
    responseAbortController: null,
    activeAssistantResponse: null,
    activeAssistantDraftResponse: null
  } as SessionState;
}

// Derives a stable session id from an incoming chat message.
export { buildSessionId };

// Restores a persisted session snapshot into runtime state.
export function restoreSessionState(item: PersistedSessionState): SessionState {
  const modeId = item.modeId ?? getDefaultSessionModeId();
  const source = item.source ?? getSessionSource(item.id);
  const participantRef = resolveSessionParticipantRef({
    sessionId: item.id,
    type: item.type,
    participantRef: item.participantRef
  });
  const title = String(item.title ?? "").trim() || resolveSessionDefaultTitle({
    source,
    type: item.type,
    id: item.id,
    modeId,
    participantRef
  });
  return {
    id: item.id,
    type: item.type,
    source,
    modeId,
    operationMode: cloneSessionOperationMode(item.operationMode ?? createNormalSessionOperationMode()),
    setupConfirmed: false,
    participantRef,
    title,
    titleSource: item.titleSource ?? (String(item.title ?? "").trim() ? "manual" : "default"),
    replyDelivery: item.replyDelivery ?? item.source ?? getSessionSource(item.id),
    debugControl: {
      enabled: item.debugControl?.enabled === true,
      oncePending: false
    },
    pendingMessages: item.pendingMessages.map((message) => (
      message.groupId
        ? {
            userId: message.userId,
            groupId: message.groupId,
            senderName: message.senderName,
            chatType: message.chatType,
            text: message.text,
            images: [...message.images],
            audioSources: [...message.audioSources],
            audioIds: [...(message.audioIds ?? [])],
            emojiSources: [...message.emojiSources],
            imageIds: [...message.imageIds],
            emojiIds: [...message.emojiIds],
            attachments: [...(message.attachments ?? [])],
            forwardIds: [...message.forwardIds],
            replyMessageId: message.replyMessageId,
            mentionUserIds: [...message.mentionUserIds],
            mentionedAll: message.mentionedAll,
            isAtMentioned: message.isAtMentioned,
            rawEvent: message.rawEvent,
            receivedAt: message.receivedAt
          }
        : {
            userId: message.userId,
            senderName: message.senderName,
            chatType: message.chatType,
            text: message.text,
            images: [...message.images],
            audioSources: [...message.audioSources],
            audioIds: [...(message.audioIds ?? [])],
            emojiSources: [...message.emojiSources],
            imageIds: [...message.imageIds],
            emojiIds: [...message.emojiIds],
            attachments: [...(message.attachments ?? [])],
            forwardIds: [...message.forwardIds],
            replyMessageId: message.replyMessageId,
            mentionUserIds: [...message.mentionUserIds],
            mentionedAll: message.mentionedAll,
            isAtMentioned: message.isAtMentioned,
            rawEvent: message.rawEvent,
            receivedAt: message.receivedAt
          }
    )),
    pendingSteerMessages: [],
    pendingReplyGateWaitPasses: 0,
    pendingTranscriptGroupId: item.pendingTranscriptGroupId ?? null,
    activeTranscriptGroupId: item.activeTranscriptGroupId ?? null,
    pendingInternalTriggers: [],
    interruptibleGroupTriggerUserId: null,
    historySummary: item.historySummary,
    internalTranscript: normalizeTranscriptItems(item.internalTranscript),
    debugMarkers: [...item.debugMarkers],
    recentToolEvents: [...item.recentToolEvents],
    lastLlmUsage: item.lastLlmUsage,
    sentMessages: [...item.sentMessages],
    phase: { kind: "idle" },
    responseEpoch: 0,
    messageQueue: [],
    lastActiveAt: item.lastActiveAt,
    lastMessageAt: item.lastMessageAt,
    latestGapMs: item.latestGapMs,
    smoothedGapMs: item.smoothedGapMs,
    historyRevision: 0,
    mutationEpoch: 0,
    debounceTimer: null,
    generationAbortController: null,
    responseAbortController: null,
    activeAssistantResponse: null,
    activeAssistantDraftResponse: null
  } as SessionState;
}

// Converts runtime session state into its persisted snapshot form.
export function toPersistedSessionState(session: SessionState): PersistedSessionState {
  return {
    id: session.id,
    type: session.type,
    source: session.source,
    modeId: session.modeId,
    operationMode: cloneSessionOperationMode(session.operationMode),
    participantRef: session.participantRef,
    title: session.title,
    titleSource: session.titleSource,
    replyDelivery: session.replyDelivery,
    debugControl: {
      enabled: session.debugControl.enabled
    },
    pendingMessages: [...session.pendingMessages],
    pendingTranscriptGroupId: session.pendingTranscriptGroupId,
    activeTranscriptGroupId: session.activeTranscriptGroupId,
    historySummary: session.historySummary,
    internalTranscript: session.internalTranscript.map((item) => ({ ...item })),
    debugMarkers: [...session.debugMarkers],
    recentToolEvents: [...session.recentToolEvents],
    lastLlmUsage: session.lastLlmUsage,
    sentMessages: [...session.sentMessages],
    lastActiveAt: session.lastActiveAt,
    lastMessageAt: session.lastMessageAt,
    latestGapMs: session.latestGapMs,
    smoothedGapMs: session.smoothedGapMs
  };
}
