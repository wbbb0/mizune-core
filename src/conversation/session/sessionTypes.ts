import type { OneBotMessageEvent, OneBotSpecialSegmentSummary } from "#services/onebot/types.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
import type { SessionOperationMode } from "./sessionOperationMode.ts";
import type {
  InternalTranscriptItem as InternalTranscriptItemContract,
  NormalizedInternalTranscriptItem,
  StoredToolCall as StoredToolCallContract,
  TranscriptItemDeliveryRef as TranscriptItemDeliveryRefContract,
  TranscriptContentSafetyEvent as TranscriptContentSafetyEventContract,
  TranscriptItemMeta as TranscriptItemMetaContract,
  TranscriptItemRuntimeExclusionReason as TranscriptItemRuntimeExclusionReasonContract,
  TranscriptItemRuntimeVisibility as TranscriptItemRuntimeVisibilityContract,
  TranscriptItemSourceRef as TranscriptItemSourceRefContract,
  TranscriptTokenStat as TranscriptTokenStatContract,
  TranscriptTokenStats as TranscriptTokenStatsContract
} from "./transcriptContract.ts";
// Defines the public session data contracts shared across conversation modules.

export type SessionDelivery = "onebot" | "web";
export type SessionSource = "onebot" | "web";
export interface SessionParticipantRef {
  kind: "user" | "group";
  id: string;
}

export type SessionTitleSource = "default" | "auto" | "manual";

export interface SessionMessage {
  chatType: "private" | "group";
  userId: string;
  groupId?: string | undefined;
  senderName: string;
  text: string;
  images: string[];
  audioSources: string[];
  audioIds: string[];
  emojiSources: string[];
  imageIds: string[];
  emojiIds: string[];
  attachments?: ChatAttachment[];
  specialSegments?: OneBotSpecialSegmentSummary[];
  forwardIds: string[];
  replyMessageId: string | null;
  mentionUserIds: string[];
  mentionedAll: boolean;
  isAtMentioned: boolean;
  rawEvent?: OneBotMessageEvent | undefined;
  receivedAt: number;
}

export interface PersistedSessionMessage {
  userId: string;
  groupId?: string | undefined;
  senderName: string;
  chatType: "private" | "group";
  text: string;
  images: string[];
  audioSources: string[];
  audioIds: string[];
  emojiSources: string[];
  imageIds: string[];
  emojiIds: string[];
  attachments?: ChatAttachment[];
  specialSegments?: OneBotSpecialSegmentSummary[];
  forwardIds: string[];
  replyMessageId: string | null;
  mentionUserIds: string[];
  mentionedAll: boolean;
  isAtMentioned: boolean;
  rawEvent?: OneBotMessageEvent | undefined;
  receivedAt: number;
}

export interface SessionHistoryMessage {
  role: "user" | "assistant";
  content: string;
  timestampMs: number;
}

export type DebugLiteral =
  | "full_system_prompt"
  | "history_summary"
  | "tools_info"
  | "image_captions"
  | "user_infos"
  | "persona"
  | "recent_history"
  | "current_batch"
  | "live_resources"
  | "debug_markers"
  | "last_llm_usage"
  | "tool_transcript";

export interface SessionDebugMarker {
  kind: "debug_enabled" | "debug_disabled" | "debug_once_armed" | "debug_once_consumed" | "debug_dump_sent";
  timestampMs: number;
  literals?: DebugLiteral[] | undefined;
  sentCount?: number | undefined;
  note?: string | undefined;
}

export type StoredToolCall = StoredToolCallContract;
export type TranscriptItemRuntimeExclusionReason = TranscriptItemRuntimeExclusionReasonContract;
export type TranscriptItemRuntimeVisibility = TranscriptItemRuntimeVisibilityContract;
export type TranscriptItemSourceRef = TranscriptItemSourceRefContract;
export type TranscriptItemDeliveryRef = TranscriptItemDeliveryRefContract;
export type TranscriptContentSafetyEvent = TranscriptContentSafetyEventContract;
export type TranscriptItemMeta = TranscriptItemMetaContract;
export type TranscriptTokenStat = TranscriptTokenStatContract;
export type TranscriptTokenStats = TranscriptTokenStatsContract;
export type InternalTranscriptItem = InternalTranscriptItemContract;
export type { NormalizedInternalTranscriptItem };
export type TranscriptUserMessageItem = Extract<InternalTranscriptItem, { kind: "user_message" }>;
export type TranscriptAssistantMessageItem = Extract<InternalTranscriptItem, { kind: "assistant_message" }>;
export type TranscriptSessionModeSwitchItem = Extract<InternalTranscriptItem, { kind: "session_mode_switch" }>;
export type InternalAssistantToolCallItem = Extract<InternalTranscriptItem, { kind: "assistant_tool_call" }>;
export type InternalToolResultItem = Extract<InternalTranscriptItem, { kind: "tool_result" }>;
export type TranscriptOutboundMediaMessageItem = Extract<InternalTranscriptItem, { kind: "outbound_media_message" }>;
export type TranscriptDirectCommandItem = Extract<InternalTranscriptItem, { kind: "direct_command" }>;
export type TranscriptStatusMessageItem = Extract<InternalTranscriptItem, { kind: "status_message" }>;
export type TranscriptGateDecisionItem = Extract<InternalTranscriptItem, { kind: "gate_decision" }>;
export type TranscriptAdmissionDecisionItem = Extract<InternalTranscriptItem, { kind: "admission_decision" }>;
export type InternalSystemMarkerItem = Extract<InternalTranscriptItem, { kind: "system_marker" }>;
export type InternalFallbackEventItem = Extract<InternalTranscriptItem, { kind: "fallback_event" }>;
export type InternalTriggerEventItem = Extract<InternalTranscriptItem, { kind: "internal_trigger_event" }>;
export type TranscriptTitleGenerationItem = Extract<InternalTranscriptItem, { kind: "title_generation_event" }>;
export type TranscriptContextExtractionEventItem = Extract<InternalTranscriptItem, { kind: "context_extraction_event" }>;
export type SessionFallbackEventType = InternalFallbackEventItem["fallbackType"];
export type InternalTriggerStage = InternalTriggerEventItem["stage"];

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

export interface ActiveAssistantResponse {
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
  startedAt: number;
  lastUpdatedAt: number;
}

export interface SessionSentMessage {
  messageId: number;
  text: string;
  sentAt: number;
}

export interface SessionDebugControlState {
  enabled: boolean;
  oncePending: boolean;
}

export interface ScheduledInstructionTriggerExecution {
  kind: "scheduled_instruction";
  targetType: "private" | "group";
  targetUserId?: string;
  targetGroupId?: string;
  targetSenderName: string;
  jobName: string;
  instruction: string;
  enqueuedAt: number;
  resolveCompletion?: () => void;
  rejectCompletion?: (error: unknown) => void;
}

export interface ComfyTaskCompletedTriggerExecution {
  kind: "comfy_task_completed";
  targetType: "private" | "group";
  targetUserId?: string;
  targetGroupId?: string;
  targetSenderName: string;
  jobName: string;
  instruction: string;
  enqueuedAt: number;
  taskId: string;
  templateId: string;
  positivePrompt: string;
  aspectRatio: string;
  resolvedWidth: number;
  resolvedHeight: number;
  workspaceFileIds: string[];
  chatFilePaths: string[];
  comfyPromptId: string;
  autoIterationIndex: number;
  maxAutoIterations: number;
  resolveCompletion?: () => void;
  rejectCompletion?: (error: unknown) => void;
}

export interface ComfyTaskFailedTriggerExecution {
  kind: "comfy_task_failed";
  targetType: "private" | "group";
  targetUserId?: string;
  targetGroupId?: string;
  targetSenderName: string;
  jobName: string;
  instruction: string;
  enqueuedAt: number;
  taskId: string;
  templateId: string;
  positivePrompt: string;
  aspectRatio: string;
  resolvedWidth: number;
  resolvedHeight: number;
  comfyPromptId: string;
  lastError: string;
  autoIterationIndex: number;
  maxAutoIterations: number;
  resolveCompletion?: () => void;
  rejectCompletion?: (error: unknown) => void;
}

export type TerminalInputPromptKind =
  | "confirmation"
  | "password"
  | "selection"
  | "text_input"
  | "unknown_prompt";

export interface TerminalSessionClosedTriggerExecution {
  kind: "terminal_session_closed";
  targetType: "private" | "group";
  targetUserId?: string;
  targetGroupId?: string;
  targetSenderName: string;
  jobName: string;
  instruction: string;
  enqueuedAt: number;
  resourceId: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  output: string;
  outputTruncated: boolean;
  resolveCompletion?: () => void;
  rejectCompletion?: (error: unknown) => void;
}

export interface TerminalInputRequiredTriggerExecution {
  kind: "terminal_input_required";
  targetType: "private" | "group";
  targetUserId?: string;
  targetGroupId?: string;
  targetSenderName: string;
  jobName: string;
  instruction: string;
  enqueuedAt: number;
  resourceId: string;
  command: string;
  cwd: string;
  promptKind: TerminalInputPromptKind;
  promptText: string;
  promptSignature: string;
  detectedAtMs: number;
  outputTail: string;
  resolveCompletion?: () => void;
  rejectCompletion?: (error: unknown) => void;
}

export type InternalSessionTriggerExecution =
  | ScheduledInstructionTriggerExecution
  | ComfyTaskCompletedTriggerExecution
  | ComfyTaskFailedTriggerExecution
  | TerminalSessionClosedTriggerExecution
  | TerminalInputRequiredTriggerExecution;

export type SessionPhase =
  | { kind: "idle" }
  | { kind: "debouncing" }
  | { kind: "turn_planner_evaluating" }
  | { kind: "turn_planner_waiting" }
  | { kind: "requesting_llm" }
  | { kind: "reasoning" }
  | { kind: "generating" }
  | { kind: "tool_calling"; toolNames: string[]; lastToolName: string | null }
  | { kind: "delivering" };

export interface SessionState {
  id: string;
  type: "private" | "group";
  source: SessionSource;
  modeId: string;
  operationMode: SessionOperationMode;
  setupConfirmed: boolean;
  participantRef: SessionParticipantRef;
  title: string | null;
  titleSource: SessionTitleSource | null;
  replyDelivery: SessionDelivery;
  debugControl: SessionDebugControlState;
  pendingMessages: SessionMessage[];
  pendingSteerMessages: SessionMessage[];
  pendingReplyGateWaitPasses: number;
  pendingTranscriptGroupId: string | null;
  activeTranscriptGroupId: string | null;
  pendingInternalTriggers: InternalSessionTriggerExecution[];
  interruptibleGroupTriggerUserId: string | null;
  historySummary: string | null;
  historyBackfillBoundaryMs: number;
  internalTranscript: InternalTranscriptItem[];
  debugMarkers: SessionDebugMarker[];
  lastLlmUsage: SessionUsageSnapshot | null;
  sentMessages: SessionSentMessage[];
  phase: SessionPhase;
  responseEpoch: number;
  messageQueue: string[];
  lastActiveAt: number;
  lastMessageAt: number | null;
  latestGapMs: number | null;
  smoothedGapMs: number | null;
  historyRevision: number;
  mutationEpoch: number;
  debounceTimer: NodeJS.Timeout | null;
  generationAbortController: AbortController | null;
  responseAbortController: AbortController | null;
  activeAssistantResponse: ActiveAssistantResponse | null;
  activeAssistantDraftResponse: ActiveAssistantResponse | null;
}

export interface PersistedSessionState {
  id: string;
  type: "private" | "group";
  source?: SessionSource;
  modeId?: string;
  operationMode?: SessionOperationMode;
  participantRef: SessionParticipantRef;
  title: string | null;
  titleSource: SessionTitleSource | null;
  replyDelivery?: SessionDelivery;
  debugControl?: {
    enabled?: boolean;
  };
  pendingMessages: PersistedSessionMessage[];
  pendingTranscriptGroupId?: string | null;
  activeTranscriptGroupId?: string | null;
  historySummary: string | null;
  historyBackfillBoundaryMs?: number;
  internalTranscript: InternalTranscriptItem[];
  debugMarkers: SessionDebugMarker[];
  lastLlmUsage: SessionUsageSnapshot | null;
  sentMessages: SessionSentMessage[];
  lastActiveAt: number;
  lastMessageAt: number | null;
  latestGapMs: number | null;
  smoothedGapMs: number | null;
}
