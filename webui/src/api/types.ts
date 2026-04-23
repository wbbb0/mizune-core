import type {
  NormalizedInternalTranscriptItem as SharedTranscriptItem,
  StoredToolCall,
  TranscriptItemPatch
} from "../../../src/conversation/session/transcriptContract.ts";

export type { StoredToolCall, TranscriptItemPatch };

// ── Session list ──────────────────────────────────────────────────────────────

export interface SessionParticipantRef {
  kind: "user" | "group";
  id: string;
}

export type SessionTitleSource = "default" | "auto" | "manual";

export interface SessionListItem {
  id: string;
  type: "private" | "group";
  source: "onebot" | "web";
  modeId: string;
  participantRef: SessionParticipantRef;
  title: string | null;
  titleSource: SessionTitleSource | null;
  isGenerating: boolean;
  lastActiveAt: number;
}

export type SessionListStreamEvent =
  | { type: "ready"; sessions: SessionListItem[]; timestampMs: number }
  | { type: "session_upsert"; session: SessionListItem; timestampMs: number }
  | { type: "session_removed"; sessionId: string; timestampMs: number };

// ── Transcript items (shared with bot transcript contract) ───────────────────

export type TranscriptItem = SharedTranscriptItem;

// ── SSE event types ───────────────────────────────────────────────────────────

export type SessionPhase =
  | { kind: "idle"; label: string }
  | { kind: "debouncing"; label: string }
  | { kind: "turn_planner_evaluating"; label: string }
  | { kind: "turn_planner_waiting"; label: string }
  | { kind: "requesting_llm"; label: string }
  | { kind: "generating"; label: string }
  | { kind: "tool_calling"; label: string; toolNames: string[]; lastToolName: string | null }
  | { kind: "delivering"; label: string; previewText?: string | null };

export type SessionStreamEvent =
  | { type: "ready";   sessionId: string; modeId: string; mutationEpoch: number; transcriptCount: number; lastActiveAt: number; phase: SessionPhase; timestampMs: number }
  | {
      type: "reset";
      sessionId: string;
      modeId: string;
      mutationEpoch: number;
      transcriptCount: number;
      lastActiveAt: number;
      phase: SessionPhase;
      reason: "mutation_epoch_changed" | "transcript_cursor_ahead" | "transcript_gap_detected";
      timestampMs: number;
    }
  | { type: "status";  sessionId: string; modeId: string; mutationEpoch: number; lastActiveAt: number; phase: SessionPhase; timestampMs: number }
  | { type: "transcript_item_added"; sessionId: string; mutationEpoch: number; index: number; totalCount: number; item: TranscriptItem; timestampMs: number }
  | { type: "transcript_item_patched"; sessionId: string; mutationEpoch: number; itemId: string; patch: TranscriptItemPatch; timestampMs: number }
  | { type: "session_error"; message: string };

export interface SessionModeOption {
  id: string;
  title: string;
  description: string;
  allowedChatTypes?: Array<"private" | "group">;
}

export interface SessionDebugControlState {
  enabled: boolean;
  oncePending: boolean;
}

export interface SessionToolEvent {
  toolName: string;
  argsSummary: string;
  outcome: "success" | "error";
  resultSummary: string;
  timestampMs: number;
}

export interface SessionDebugMarker {
  kind: "debug_enabled" | "debug_disabled" | "debug_once_armed" | "debug_once_consumed" | "debug_dump_sent";
  timestampMs: number;
  sentCount?: number;
  note?: string;
}

export interface SessionUsageSnapshot {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  requestCount: number;
  providerReported: boolean;
  modelRef: string | null;
  model: string | null;
  capturedAt: number;
}

export interface SessionSentMessage {
  messageId: number;
  text: string;
  sentAt: number;
}

export interface SessionDetailSnapshot {
  id: string;
  type: "private" | "group";
  source: "onebot" | "web";
  modeId: string;
  participantRef: SessionParticipantRef;
  title: string | null;
  titleSource: SessionTitleSource | null;
  titleGenerationAvailable: boolean;
  debugControl: SessionDebugControlState;
  historySummary: string | null;
  internalTranscript: TranscriptItem[];
  debugMarkers: SessionDebugMarker[];
  recentToolEvents: SessionToolEvent[];
  lastLlmUsage: SessionUsageSnapshot | null;
  sentMessages: SessionSentMessage[];
  lastActiveAt: number;
  isGenerating: boolean;
  historyRevision: number;
  mutationEpoch: number;
}

export interface ScenarioHostObjective {
  id: string;
  title: string;
  status: "active" | "completed" | "failed";
  summary: string;
}

export interface ScenarioHostInventoryItem {
  ownerId: string;
  item: string;
  quantity: number;
}

export interface ScenarioHostSessionState {
  version: 1;
  currentSituation: string;
  currentLocation: string | null;
  sceneSummary: string;
  player: {
    userId: string;
    displayName: string;
  };
  inventory: ScenarioHostInventoryItem[];
  objectives: ScenarioHostObjective[];
  worldFacts: string[];
  flags: Record<string, string | number | boolean>;
  initialized: boolean;
  turnIndex: number;
}

export type SessionModeStateDetail =
  | { kind: "scenario_host"; state: ScenarioHostSessionState }
  | null;

export interface SessionDetailResult {
  session: SessionDetailSnapshot;
  modeState: SessionModeStateDetail;
}

export type TurnStreamEvent =
  | { type: "ready";    turnId: string; sessionId: string; timestampMs: number }
  | { type: "draft_delta"; turnId: string; sessionId: string; delta: string; timestampMs: number }
  | { type: "segment_committed"; turnId: string; sessionId: string; timestampMs: number }
  | { type: "complete"; turnId: string; sessionId: string; timestampMs: number }
  | { type: "turn_error"; turnId: string; sessionId: string; message: string; timestampMs: number };

// ── Transcript pagination ─────────────────────────────────────────────────────

export interface TranscriptFetchItem {
  eventId: string;
  index: number;
  item: TranscriptItem;
}

export interface TranscriptFetchResult {
  items: TranscriptFetchItem[];
  totalCount: number;
  hasMore: boolean;
}
