import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import { getDefaultSessionModeId } from "#modes/registry.ts";
import type { SessionState, PersistedSessionState } from "./sessionTypes.ts";
import {
  buildSessionId,
  deriveParticipantUserId,
  getSessionSource,
  resolveSessionParticipantLabel
} from "./sessionIdentity.ts";

// Creates and converts runtime session state snapshots.

// Builds an empty in-memory session state for a target conversation.
export function createSessionState(target: {
  id: string;
  type: "private" | "group";
  source?: "onebot" | "web";
  participantUserId?: string;
  participantLabel?: string | null;
}): SessionState {
  const participantUserId = target.participantUserId ?? deriveParticipantUserId(target.id, target.type);
  return {
    id: target.id,
    type: target.type,
    source: target.source ?? getSessionSource(target.id),
    modeId: getDefaultSessionModeId(),
    setupConfirmed: false,
    participantUserId,
    participantLabel: resolveSessionParticipantLabel({
      sessionId: target.id,
      participantLabel: target.participantLabel,
      participantUserId,
      type: target.type
    }),
    replyDelivery: target.source ?? getSessionSource(target.id),
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
    activeAssistantResponse: null
  };
}

// Derives a stable session id from an incoming chat message.
export { buildSessionId };

// Restores a persisted session snapshot into runtime state.
export function restoreSessionState(item: PersistedSessionState): SessionState {
  const participantUserId = item.participantUserId ?? deriveParticipantUserId(item.id, item.type);
  return {
    id: item.id,
    type: item.type,
    source: item.source ?? getSessionSource(item.id),
    modeId: item.modeId ?? getDefaultSessionModeId(),
    setupConfirmed: false,
    participantUserId,
    participantLabel: resolveSessionParticipantLabel({
      sessionId: item.id,
      participantLabel: item.participantLabel,
      participantUserId,
      type: item.type
    }),
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
    internalTranscript: [...item.internalTranscript],
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
    activeAssistantResponse: null
  };
}

// Converts runtime session state into its persisted snapshot form.
export function toPersistedSessionState(session: SessionState): PersistedSessionState {
  return {
    id: session.id,
    type: session.type,
    source: session.source,
    modeId: session.modeId,
    participantUserId: session.participantUserId,
    participantLabel: session.participantLabel,
    replyDelivery: session.replyDelivery,
    debugControl: {
      enabled: session.debugControl.enabled
    },
    pendingMessages: [...session.pendingMessages],
    pendingTranscriptGroupId: session.pendingTranscriptGroupId,
    activeTranscriptGroupId: session.activeTranscriptGroupId,
    historySummary: session.historySummary,
    internalTranscript: [...session.internalTranscript],
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
