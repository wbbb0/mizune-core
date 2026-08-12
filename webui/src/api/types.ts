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

export interface SessionSnapshotSummary {
  id: string;
  sessionId: string;
  label: string;
  createdAtMs: number;
  modeId: string;
  title: string | null;
  transcriptCount: number;
  hasScenarioHostState: boolean;
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
  | { kind: "reasoning"; label: string }
  | { kind: "generating"; label: string }
  | { kind: "tool_calling"; label: string; toolNames: string[]; lastToolName: string | null }
  | { kind: "delivering"; label: string; previewText?: string | null };

export interface SessionStatusPatch {
  modeId?: string;
  lastActiveAt?: number;
  phase?: SessionPhase;
}

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
  | { type: "status_patch";  sessionId: string; mutationEpoch: number; patch: SessionStatusPatch; timestampMs: number }
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
  lastRequestUsage?: SessionRequestUsageSnapshot | null;
}

export interface SessionRequestUsageSnapshot {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  requestCount: number;
  providerReported: boolean;
  modelRef: string | null;
  model: string | null;
}

export type SessionTaskStatus =
  | "active"
  | "waiting_tool"
  | "waiting_user"
  | "ready_to_close"
  | "suspended"
  | "cancel_confirming"
  | "completed"
  | "canceled"
  | "failed";

export interface TaskResourceRef {
  kind: "filesystem" | "shell_session" | "browser_page" | "asset" | "search_result" | "external";
  id: string;
  locator?: string;
  version?: string;
}

export interface TaskToolRef {
  toolCallId: string;
  toolName: string;
  summary?: string;
  resource?: TaskResourceRef;
  refetchHint?: string;
  pinned?: boolean;
  createdAtMs?: number;
}

export interface SessionTaskState {
  taskId: string;
  status: SessionTaskStatus;
  objective: string;
  originalRequest?: string;
  done: string[];
  next: string[];
  blockers: string[];
  importantToolRefs: TaskToolRef[];
  createdAtMs: number;
  updatedAtMs: number;
  readyToCloseAtMs?: number;
}

export interface ParkedTaskState {
  taskId: string;
  status: SessionTaskStatus;
  objective: string;
  summary: string;
  importantToolRefs: TaskToolRef[];
  updatedAtMs: number;
}

export interface SessionTaskTracker {
  version: 1;
  primary: SessionTaskState | null;
  parked: ParkedTaskState[];
}

export interface SessionSentMessage {
  messageId: number;
  text: string;
  sentAt: number;
}

export interface ContentSafetyAuditView {
  key: string;
  subjectKind: "text" | "image" | "emoji" | "audio_transcript" | "file" | "local_media";
  decision: "allow" | "review" | "block" | "error";
  marker: string;
  reason: string;
  labels: Array<{
    label: string;
    category?: string;
    riskLevel?: "none" | "low" | "medium" | "high";
    confidence?: number;
    providerReason?: string;
  }>;
  providerId: string;
  providerType: string;
  requestId?: string;
  rawDecision?: string;
  originalText?: string;
  fileId?: string;
  audioId?: string;
  contentHash?: string;
  sourceName?: string;
  sessionId?: string;
  checkedAtMs: number;
  expiresAtMs?: number;
}

export type MemoryContextScope = "session" | "user" | "global" | "toolset" | "mode";
export type MemoryContextLayer = "profile_slot" | "core_fact" | "searchable_fact" | "episode" | "proposal";
export type MemoryContextSubjectKind = "session" | "user" | "global" | "toolset" | "mode";
export type MemoryContextSourceType = "episode" | "chunk" | "summary" | "fact" | "rule";
export type MemoryContextEntrySource = "semantic_retrieval";
export type MemoryContextRetrievalSkipReason =
  | "scenario_host_mode"
  | "assistant_mode"
  | "missing_user"
  | "service_unavailable";

export interface MemoryContextRetrievalDebugReport {
  userId: string;
  queryText: string;
  embeddingProfileId?: string;
  candidateCount: number;
  indexedCount: number;
  selectedCount: number;
  droppedCount: number;
  error?: string;
  createdAt: number;
}

export interface MemoryContextItem {
  itemId: string;
  entrySource: MemoryContextEntrySource;
  scope: MemoryContextScope;
  layer: MemoryContextLayer;
  subjectKind: MemoryContextSubjectKind;
  subjectId?: string;
  sourceType: MemoryContextSourceType;
  title?: string;
  slotKey?: string;
  kind?: "preference" | "fact" | "boundary" | "habit" | "relationship" | "other";
  memorySource?: "user_explicit" | "owner_explicit" | "inferred";
  text: string;
  score?: number;
  importance?: number;
  updatedAt: number;
}

export interface MemoryContextReport {
  sessionId: string;
  modeId?: string;
  userId?: string;
  queryText: string;
  currentUserFactCount: number;
  availableUserFactCount: number;
  userFactLimit: number;
  userFactTruncated: boolean;
  currentSessionFactCount: number;
  availableSessionFactCount: number;
  sessionFactLimit: number;
  sessionFactTruncated: boolean;
  retrievedUserContextCount: number;
  selectedCount: number;
  semanticRetrieval: {
    attempted: boolean;
    skippedReason?: MemoryContextRetrievalSkipReason;
    debugReport?: MemoryContextRetrievalDebugReport;
  };
  retrievedUserContext: MemoryContextItem[];
  createdAt: number;
}

export type DerivedObservationSourceKind = "tool_result" | "chat_file" | "audio" | "session" | "history";
export type DerivedObservationPurpose =
  | "tool_replay_compaction"
  | "image_caption"
  | "audio_transcription"
  | "session_title"
  | "history_summary";
export type DerivedObservationStatus = "missing" | "queued" | "ready" | "failed";

export interface DerivedObservation {
  sourceKind: DerivedObservationSourceKind;
  sourceId: string;
  purpose: DerivedObservationPurpose;
  status: DerivedObservationStatus;
  text: string | null;
  modelRef?: string | null;
  promptVersion?: string;
  sourceHash?: string;
  updatedAt?: number;
  error?: string | null;
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
  taskTracker: SessionTaskTracker;
  derivedObservations: DerivedObservation[];
  internalTranscript: TranscriptItem[];
  debugMarkers: SessionDebugMarker[];
  lastLlmUsage: SessionUsageSnapshot | null;
  sentMessages: SessionSentMessage[];
  contentSafetyAudits: ContentSafetyAuditView[];
  memoryContext: MemoryContextReport | null;
  lastActiveAt: number;
  isGenerating: boolean;
  historyRevision: number;
  mutationEpoch: number;
}

export interface SessionPacingPreferences {
  inputDebounce:
    | { mode: "adaptive" }
    | { mode: "immediate" }
    | { mode: "fixed"; delayMs: number };
  oneBotOutbound: "humanized" | "immediate";
  toolLoopOutput: "progressive" | "final_only";
}

export interface SessionToolsetPreferences {
  overrides: Record<string, "enabled" | "disabled">;
}

export interface SessionToolsetOption {
  id: string;
  title: string;
  description: string;
  toolNames: string[];
  defaultEnabled: boolean;
  effectiveEnabled: boolean;
  override: "enabled" | "disabled" | null;
  ownerOnly: boolean;
  debugOnly: boolean;
}

export interface SessionSettings {
  pacingPreferences: SessionPacingPreferences;
  toolsetPreferences: SessionToolsetPreferences;
}

export interface SessionSettingsResult {
  settings: SessionSettings;
  toolsetOptions: SessionToolsetOption[];
}

export interface ScenarioHostObjective {
  id: string;
  title: string;
  status: "active" | "completed" | "failed";
  summary: string;
}

export interface ScenarioHostWornItem {
  name: string;
  wearPosition: string;
  description: string;
}

export interface ScenarioHostHeldItem {
  name: string;
  description: string;
  quantity: number;
}

export interface ScenarioHostLoreEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  activationKeys: string[];
  enabled: boolean;
  priority: number;
  createdAtTurn: number;
  updatedAtTurn: number;
}

export type ScenarioHostEntityKind = "location" | "faction" | "item" | "organization" | "other";

export interface ScenarioHostEntity {
  id: string;
  kind: ScenarioHostEntityKind;
  name: string;
  aliases: string[];
  summary: string;
  status: string;
  locationId: string | null;
  tags: string[];
  notes: string;
}

export interface ScenarioHostNpc {
  id: string;
  name: string;
  aliases: string[];
  basicInfo: string;
  characterDescription: string;
  wornItems: ScenarioHostWornItem[];
  heldItems: ScenarioHostHeldItem[];
  statusDescription: string;
  locationId: string | null;
  tags: string[];
  notes: string;
}

export interface ScenarioHostRelation {
  sourceId: string;
  targetId: string;
  kind: string;
  summary: string;
  strength: number;
  updatedAtTurn: number;
}

export interface ScenarioHostJournalEntry {
  id: string;
  turnIndex: number;
  title: string;
  summary: string;
  entityIds: string[];
  tags: string[];
  createdAtMs: number;
}

export interface ScenarioHostMechanics {
  ruleStyle: "freeform" | "light_checks" | "dice";
  dicePolicy: string;
  difficultyScale: string;
  successStates: string[];
}

export type ScenarioSetupOptionalItemKey =
  | "boundaries"
  | "openingSituation"
  | "currentLocation"
  | "sceneSummary"
  | "initialNpcs"
  | "initialObjectives"
  | "loreEntries"
  | "entities"
  | "relations"
  | "mechanics";

export interface ScenarioHostSetupProgress {
  skippedOptionalItems: ScenarioSetupOptionalItemKey[];
}

export interface ScenarioHostSessionState {
  version: 5;
  profile: {
    theme: string;
    worldBaseline: string;
    narrationStyle: string;
    boundaries: string;
  };
  currentSituation: string;
  currentLocation: string | null;
  sceneSummary: string;
  player: {
    userId: string;
    displayName: string;
    basicInfo: string;
    characterDescription: string;
    wornItems: ScenarioHostWornItem[];
    heldItems: ScenarioHostHeldItem[];
    statusDescription: string;
  };
  objectives: ScenarioHostObjective[];
  loreEntries: ScenarioHostLoreEntry[];
  npcs: ScenarioHostNpc[];
  entities: ScenarioHostEntity[];
  relations: ScenarioHostRelation[];
  journal: ScenarioHostJournalEntry[];
  mechanics: ScenarioHostMechanics;
  flags: Record<string, string | number | boolean>;
  setupProgress: ScenarioHostSetupProgress;
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
