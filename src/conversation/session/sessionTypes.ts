import type { OneBotMessageEvent } from "#services/onebot/types.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";
// Defines the public session data contracts shared across conversation modules.

export type SessionDelivery = "onebot" | "web";
export type SessionSource = "onebot" | "web";

export interface StoredToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  providerMetadata?: Record<string, unknown> | undefined;
}

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

export interface SessionToolEvent {
  toolName: string;
  argsSummary: string;
  outcome: "success" | "error";
  resultSummary: string;
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
  | "runtime_resources"
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

export interface TranscriptUserMessageItem {
  kind: "user_message";
  role: "user";
  llmVisible: true;
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
  imageIds: string[];
  emojiIds: string[];
  attachments?: ChatAttachment[];
  audioCount: number;
  forwardIds: string[];
  replyMessageId: string | null;
  mentionUserIds: string[];
  mentionedAll: boolean;
  mentionedSelf: boolean;
  timestampMs: number;
}

export interface TranscriptAssistantMessageItem {
  kind: "assistant_message";
  role: "assistant";
  llmVisible: true;
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
  timestampMs: number;
}

export interface InternalAssistantToolCallItem {
  kind: "assistant_tool_call";
  llmVisible: true;
  timestampMs: number;
  content: string;
  toolCalls: StoredToolCall[];
  reasoningContent?: string | undefined;
  providerMetadata?: Record<string, unknown> | undefined;
}

export interface InternalToolResultItem {
  kind: "tool_result";
  llmVisible: true;
  timestampMs: number;
  toolCallId: string;
  toolName: string;
  content: string;
}

export interface TranscriptOutboundMediaMessageItem {
  kind: "outbound_media_message";
  llmVisible: false;
  role: "assistant";
  delivery: SessionDelivery;
  mediaKind: "image";
  assetId: string;
  filename: string | null;
  messageId: number | null;
  toolName: "send_workspace_media_to_chat";
  captionText?: string | null | undefined;
  timestampMs: number;
}

export interface TranscriptDirectCommandItem {
  kind: "direct_command";
  llmVisible: false;
  direction: "input" | "output";
  role: "user" | "assistant";
  commandName: string;
  content: string;
  timestampMs: number;
}

export interface TranscriptStatusMessageItem {
  kind: "status_message";
  llmVisible: false;
  role: "assistant";
  statusType: "system" | "command";
  content: string;
  timestampMs: number;
}

export interface TranscriptGateDecisionItem {
  kind: "gate_decision";
  llmVisible: false;
  action: "continue" | "wait" | "skip" | "topic_switch";
  reason: string | null;
  waitPassCount?: number | undefined;
  replyDecision?: "reply_small" | "reply_large" | "wait" | "ignore" | undefined;
  topicDecision?: string | undefined;
  timestampMs: number;
}

export interface InternalSystemMarkerItem {
  kind: "system_marker";
  llmVisible: false;
  timestampMs: number;
  markerType: SessionDebugMarker["kind"];
  content: string;
}

export type SessionFallbackEventType = "model_candidate_switch" | "generation_failure_reply";

export interface InternalFallbackEventItem {
  kind: "fallback_event";
  llmVisible: false;
  timestampMs: number;
  fallbackType: SessionFallbackEventType;
  title: string;
  summary: string;
  details: string;
  fromModelRef?: string | undefined;
  toModelRef?: string | undefined;
  fromProvider?: string | undefined;
  toProvider?: string | undefined;
  failureMessage?: string | undefined;
}

export type InternalTriggerStage = "received" | "queued" | "dequeued" | "started";

export interface InternalTriggerEventItem {
  kind: "internal_trigger_event";
  llmVisible: false;
  timestampMs: number;
  triggerKind: InternalSessionTriggerExecution["kind"];
  stage: InternalTriggerStage;
  title: string;
  summary: string;
  jobName: string;
  targetType: "private" | "group";
  targetUserId?: string | undefined;
  targetGroupId?: string | undefined;
  taskId?: string | undefined;
  templateId?: string | undefined;
  comfyPromptId?: string | undefined;
  autoIterationIndex?: number | undefined;
  maxAutoIterations?: number | undefined;
  details?: string | undefined;
}

export type InternalTranscriptItem =
  | TranscriptUserMessageItem
  | TranscriptAssistantMessageItem
  | InternalAssistantToolCallItem
  | InternalToolResultItem
  | TranscriptOutboundMediaMessageItem
  | TranscriptDirectCommandItem
  | TranscriptStatusMessageItem
  | TranscriptGateDecisionItem
  | InternalSystemMarkerItem
  | InternalFallbackEventItem
  | InternalTriggerEventItem;

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
  workspaceAssetIds: string[];
  workspacePaths: string[];
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

export type InternalSessionTriggerExecution =
  | ScheduledInstructionTriggerExecution
  | ComfyTaskCompletedTriggerExecution
  | ComfyTaskFailedTriggerExecution;

export interface SessionState {
  id: string;
  type: "private" | "group";
  source: SessionSource;
  participantUserId: string;
  participantLabel: string | null;
  lastInboundDelivery: SessionDelivery;
  debugControl: SessionDebugControlState;
  pendingMessages: SessionMessage[];
  pendingSteerMessages: SessionMessage[];
  pendingReplyGateWaitPasses: number;
  pendingInternalTriggers: InternalSessionTriggerExecution[];
  interruptibleGroupTriggerUserId: string | null;
  historySummary: string | null;
  internalTranscript: InternalTranscriptItem[];
  debugMarkers: SessionDebugMarker[];
  recentToolEvents: SessionToolEvent[];
  lastLlmUsage: SessionUsageSnapshot | null;
  sentMessages: SessionSentMessage[];
  isGenerating: boolean;
  isResponding: boolean;
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
}

export interface PersistedSessionState {
  id: string;
  type: "private" | "group";
  source?: SessionSource;
  participantUserId?: string;
  participantLabel?: string | null;
  lastInboundDelivery?: SessionDelivery;
  debugControl?: {
    enabled?: boolean;
  };
  pendingMessages: PersistedSessionMessage[];
  historySummary: string | null;
  internalTranscript: InternalTranscriptItem[];
  debugMarkers: SessionDebugMarker[];
  recentToolEvents: SessionToolEvent[];
  lastLlmUsage: SessionUsageSnapshot | null;
  sentMessages: SessionSentMessage[];
  lastActiveAt: number;
  lastMessageAt: number | null;
  latestGapMs: number | null;
  smoothedGapMs: number | null;
}
