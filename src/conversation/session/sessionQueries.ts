import type {
  InternalTranscriptItem,
  PersistedSessionState,
  SessionDebugMarker,
  SessionDebugControlState,
  SessionSentMessage,
  SessionState,
  SessionToolEvent,
  SessionUsageSnapshot
} from "./sessionTypes.ts";
import { projectCompressionHistorySnapshot, projectLlmVisibleHistoryFromTranscript } from "./sessionTranscript.ts";
import type { AppConfig } from "#config/config.ts";

// Provides read-only projections and snapshots derived from session state.
export function cloneSessionState(session: SessionState): SessionState {
  return {
    ...session,
    debugControl: { ...session.debugControl },
    pendingMessages: [...session.pendingMessages],
    pendingSteerMessages: [...session.pendingSteerMessages],
    pendingInternalTriggers: [...session.pendingInternalTriggers],
    internalTranscript: [...session.internalTranscript],
    debugMarkers: [...session.debugMarkers],
    recentToolEvents: [...session.recentToolEvents],
    sentMessages: [...session.sentMessages],
    lastLlmUsage: session.lastLlmUsage == null ? null : { ...session.lastLlmUsage },
    messageQueue: [...session.messageQueue],
    activeAssistantResponse: session.activeAssistantResponse == null
      ? null
      : { ...session.activeAssistantResponse },
    phase: session.phase.kind === "tool_calling"
      ? { ...session.phase, toolNames: [...session.phase.toolNames] }
      : { ...session.phase }
  };
}

// Builds a compression snapshot from the recent message window when needed.
export function getHistoryForCompressionSnapshot(
  session: SessionState,
  config: AppConfig,
  triggerMessageCount: number,
  retainMessageCount: number
): {
  historySummary: string | null;
  messagesToCompress: ReturnType<typeof projectLlmVisibleHistoryFromTranscript>;
  retainedMessages: ReturnType<typeof projectLlmVisibleHistoryFromTranscript>;
  transcriptStartIndexToKeep: number;
} | null {
  return projectCompressionHistorySnapshot(session, config, triggerMessageCount, retainMessageCount);
}

// Builds a minimal session view for APIs and diagnostics.
export function getSessionViewSnapshot(session: SessionState): {
  id: string;
  type: "private" | "group";
  source: "onebot" | "web";
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
} {
  return {
    id: session.id,
    type: session.type,
    source: session.source,
    participantUserId: session.participantUserId,
    participantLabel: session.participantLabel,
    debugControl: { ...session.debugControl },
    historySummary: session.historySummary,
    internalTranscript: [...session.internalTranscript],
    debugMarkers: [...session.debugMarkers],
    recentToolEvents: [...session.recentToolEvents],
    lastLlmUsage: session.lastLlmUsage,
    sentMessages: [...session.sentMessages],
    lastActiveAt: session.lastActiveAt
  };
}

export function isSessionGenerating(session: SessionState): boolean {
  return [
    "reply_gate_evaluating",
    "requesting_llm",
    "generating",
    "tool_calling"
  ].includes(session.phase.kind);
}

export function isSessionResponding(session: SessionState): boolean {
  return [
    "reply_gate_evaluating",
    "requesting_llm",
    "generating",
    "tool_calling",
    "delivering"
  ].includes(session.phase.kind);
}
