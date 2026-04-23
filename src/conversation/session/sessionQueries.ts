import type {
  InternalTranscriptItem,
  NormalizedInternalTranscriptItem,
  PersistedSessionState,
  SessionDebugMarker,
  SessionDebugControlState,
  SessionSentMessage,
  SessionState,
  SessionToolEvent,
  SessionUsageSnapshot
} from "./sessionTypes.ts";
import { cloneSessionOperationMode } from "./sessionOperationMode.ts";
import { projectCompressionHistorySnapshot, projectCompressionHistorySnapshotByTokens, projectLlmVisibleHistoryFromTranscript } from "./sessionTranscript.ts";
import type { AppConfig } from "#config/config.ts";
import { normalizeTranscriptItems } from "./transcriptMetadata.ts";
import { resolveSessionParticipantLabel } from "./sessionIdentity.ts";

// Provides read-only projections and snapshots derived from session state.
export function cloneSessionState(session: SessionState): SessionState {
  return {
    ...session,
    participantRef: { ...session.participantRef },
    operationMode: cloneSessionOperationMode(session.operationMode),
    debugControl: { ...session.debugControl },
    pendingMessages: [...session.pendingMessages],
    pendingSteerMessages: [...session.pendingSteerMessages],
    pendingInternalTriggers: [...session.pendingInternalTriggers],
    internalTranscript: normalizeTranscriptItems(session.internalTranscript),
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

// Builds a compression snapshot from the recent message window when needed (message-count based).
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

// Builds a compression snapshot using estimated token counts as the trigger threshold.
export function getHistoryForCompressionSnapshotByTokens(
  session: SessionState,
  config: AppConfig,
  triggerTokens: number,
  retainTokens: number,
  reportedInputTokens?: number
): {
  historySummary: string | null;
  messagesToCompress: ReturnType<typeof projectLlmVisibleHistoryFromTranscript>;
  retainedMessages: ReturnType<typeof projectLlmVisibleHistoryFromTranscript>;
  transcriptStartIndexToKeep: number;
  estimatedTotalTokens: number;
} | null {
  return projectCompressionHistorySnapshotByTokens(session, config, triggerTokens, retainTokens, reportedInputTokens);
}

// Builds a minimal session view for APIs and diagnostics.
export function getSessionViewSnapshot(session: SessionState): {
  id: string;
  type: "private" | "group";
  source: "onebot" | "web";
  modeId: string;
  participantUserId: string;
  participantLabel: string | null;
  debugControl: SessionDebugControlState;
  historySummary: string | null;
  internalTranscript: NormalizedInternalTranscriptItem[];
  debugMarkers: SessionDebugMarker[];
  recentToolEvents: SessionToolEvent[];
  lastLlmUsage: SessionUsageSnapshot | null;
  sentMessages: SessionSentMessage[];
  lastActiveAt: number;
} {
  const participantLabel = resolveSessionParticipantLabel({
    sessionId: session.id,
    participantRef: session.participantRef,
    title: session.title
  });
  return {
    id: session.id,
    type: session.type,
    source: session.source,
    modeId: session.modeId,
    participantUserId: session.participantRef.id,
    participantLabel,
    debugControl: { ...session.debugControl },
    historySummary: session.historySummary,
    internalTranscript: normalizeTranscriptItems(session.internalTranscript),
    debugMarkers: [...session.debugMarkers],
    recentToolEvents: [...session.recentToolEvents],
    lastLlmUsage: session.lastLlmUsage,
    sentMessages: [...session.sentMessages],
    lastActiveAt: session.lastActiveAt
  };
}

export function isSessionGenerating(session: SessionState): boolean {
  return [
    "turn_planner_evaluating",
    "requesting_llm",
    "reasoning",
    "generating",
    "tool_calling"
  ].includes(session.phase.kind);
}

export function isSessionResponding(session: SessionState): boolean {
  return [
    "turn_planner_evaluating",
    "requesting_llm",
    "reasoning",
    "generating",
    "tool_calling",
    "delivering"
  ].includes(session.phase.kind);
}
