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
  participantUserId: string;
  participantRef: SessionParticipantRef;
  title: string | null;
  titleSource: SessionTitleSource | null;
  isGenerating: boolean;
  lastActiveAt: number;
}

// ── Transcript items (mirrors bot InternalTranscriptItem) ─────────────────────

export interface StoredToolCall {
  id: string;
  name?: string;
  arguments?: string;
  function?: {
    name: string;
    arguments: string;
  };
}

export type TranscriptItemRuntimeExclusionReason =
  | "manual_single"
  | "manual_group"
  | "interrupt_cleanup"
  | "system";

export interface TranscriptItemMeta {
  id: string;
  groupId: string;
  runtimeExcluded: boolean;
  runtimeExcludedAt?: number;
  runtimeExclusionReason?: TranscriptItemRuntimeExclusionReason;
  deliveryRef?: {
    platform: "onebot";
    messageId: number;
  };
}

export interface UserMessageItem extends TranscriptItemMeta {
  kind: "user_message";
  role: "user";
  llmVisible: true;
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
  imageIds: string[];
  emojiIds: string[];
  attachments?: Array<{
    fileId: string;
    kind: "image" | "animated_image" | "video" | "audio" | "file";
    source: "chat_message" | "web_upload" | "browser" | "chat_file";
    sourceName: string | null;
    mimeType: string | null;
    semanticKind?: "image" | "emoji";
  }>;
  audioCount: number;
  forwardIds: string[];
  replyMessageId: string | null;
  mentionUserIds: string[];
  mentionedAll: boolean;
  mentionedSelf: boolean;
  timestampMs: number;
}

export interface AssistantMessageItem extends TranscriptItemMeta {
  kind: "assistant_message";
  role: "assistant";
  llmVisible: true;
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
  reasoningContent?: string;
  timestampMs: number;
}

export interface SessionModeSwitchItem extends TranscriptItemMeta {
  kind: "session_mode_switch";
  role: "assistant";
  llmVisible: true;
  fromModeId: string;
  toModeId: string;
  content: string;
  timestampMs: number;
}

export interface AssistantToolCallItem extends TranscriptItemMeta {
  kind: "assistant_tool_call";
  llmVisible: true;
  timestampMs: number;
  content: string;
  toolCalls: StoredToolCall[];
  reasoningContent?: string;
}

export interface ToolResultItem extends TranscriptItemMeta {
  kind: "tool_result";
  llmVisible: true;
  timestampMs: number;
  toolCallId: string;
  toolName: string;
  content: string;
}

export interface OutboundMediaMessageItem extends TranscriptItemMeta {
  kind: "outbound_media_message";
  llmVisible: false;
  role: "assistant";
  delivery: "onebot" | "web";
  mediaKind: "image";
  fileId: string | null;
  fileRef: string | null;
  sourceName: string | null;
  chatFilePath: string | null;
  sourcePath: string | null;
  messageId: number | null;
  toolName: "chat_file_send_to_chat" | "local_file_send_to_chat";
  captionText?: string | null;
  timestampMs: number;
}

export interface DirectCommandItem extends TranscriptItemMeta {
  kind: "direct_command";
  llmVisible: false;
  direction: "input" | "output";
  role: "user" | "assistant";
  commandName: string;
  content: string;
  timestampMs: number;
}

export interface StatusMessageItem extends TranscriptItemMeta {
  kind: "status_message";
  llmVisible: false;
  role: "assistant";
  statusType: "system" | "command";
  content: string;
  timestampMs: number;
}

export interface GateDecisionItem extends TranscriptItemMeta {
  kind: "gate_decision";
  llmVisible: false;
  action: "continue" | "wait" | "skip" | "topic_switch";
  reason: string | null;
  reasoningContent?: string;
  waitPassCount?: number;
  replyDecision?: "reply_small" | "reply_large" | "wait" | "ignore";
  topicDecision?: string;
  toolsetIds?: string[];
  timestampMs: number;
}

export interface TitleGenerationEventItem extends TranscriptItemMeta {
  kind: "title_generation_event";
  llmVisible: false;
  timestampMs: number;
  source: "auto" | "regenerate";
  modeId: string;
  title: string;
  summary: string;
  details: string;
}

export interface SystemMarkerItem extends TranscriptItemMeta {
  kind: "system_marker";
  llmVisible: false;
  timestampMs: number;
  markerType: string;
  content: string;
}

export interface FallbackEventItem extends TranscriptItemMeta {
  kind: "fallback_event";
  llmVisible: false;
  timestampMs: number;
  fallbackType: "model_candidate_switch" | "generation_failure_reply";
  title: string;
  summary: string;
  details: string;
  fromModelRef?: string;
  toModelRef?: string;
  fromProvider?: string;
  toProvider?: string;
  failureMessage?: string;
}

export interface InternalTriggerEventItem extends TranscriptItemMeta {
  kind: "internal_trigger_event";
  llmVisible: false;
  timestampMs: number;
  triggerKind: "scheduled_instruction" | "comfy_task_completed" | "comfy_task_failed";
  stage: "received" | "queued" | "dequeued" | "started";
  title: string;
  summary: string;
  jobName: string;
  targetType: "private" | "group";
  targetUserId?: string;
  targetGroupId?: string;
  taskId?: string;
  templateId?: string;
  comfyPromptId?: string;
  autoIterationIndex?: number;
  maxAutoIterations?: number;
  details?: string;
}

export interface TranscriptItemPatch {
  reasoningContent?: string;
  runtimeExcluded?: boolean;
  runtimeExcludedAt?: number;
  runtimeExclusionReason?: TranscriptItemRuntimeExclusionReason;
}

export type TranscriptItem =
  | UserMessageItem
  | AssistantMessageItem
  | SessionModeSwitchItem
  | AssistantToolCallItem
  | ToolResultItem
  | OutboundMediaMessageItem
  | DirectCommandItem
  | StatusMessageItem
  | GateDecisionItem
  | TitleGenerationEventItem
  | SystemMarkerItem
  | FallbackEventItem
  | InternalTriggerEventItem;

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
  participantUserId: string;
  participantRef: SessionParticipantRef;
  title: string | null;
  titleSource: SessionTitleSource | null;
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
  | { type: "chunk";    turnId: string; sessionId: string; chunk: string; timestampMs: number }
  | { type: "complete"; turnId: string; sessionId: string; response: string; chunks: string[]; timestampMs: number }
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
