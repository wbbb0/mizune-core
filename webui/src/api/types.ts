// ── Session list ──────────────────────────────────────────────────────────────

export interface SessionListItem {
  id: string;
  type: "private" | "group";
  source: "onebot" | "web";
  participantUserId: string;
  participantLabel: string | null;
  pendingMessageCount: number;
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

export interface UserMessageItem {
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
    source: "chat_message" | "web_upload" | "browser" | "workspace";
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

export interface AssistantMessageItem {
  kind: "assistant_message";
  role: "assistant";
  llmVisible: true;
  chatType: "private" | "group";
  userId: string;
  senderName: string;
  text: string;
  timestampMs: number;
}

export interface AssistantToolCallItem {
  kind: "assistant_tool_call";
  llmVisible: true;
  timestampMs: number;
  content: string;
  toolCalls: StoredToolCall[];
  reasoningContent?: string;
}

export interface ToolResultItem {
  kind: "tool_result";
  llmVisible: true;
  timestampMs: number;
  toolCallId: string;
  toolName: string;
  content: string;
}

export interface OutboundMediaMessageItem {
  kind: "outbound_media_message";
  llmVisible: false;
  role: "assistant";
  delivery: "onebot" | "web";
  mediaKind: "image";
  fileId: string;
  fileRef: string | null;
  sourceName: string | null;
  workspacePath: string | null;
  messageId: number | null;
  toolName: "send_workspace_file_to_chat";
  captionText?: string | null;
  timestampMs: number;
}

export interface DirectCommandItem {
  kind: "direct_command";
  llmVisible: false;
  direction: "input" | "output";
  role: "user" | "assistant";
  commandName: string;
  content: string;
  timestampMs: number;
}

export interface StatusMessageItem {
  kind: "status_message";
  llmVisible: false;
  role: "assistant";
  statusType: "system" | "command";
  content: string;
  timestampMs: number;
}

export interface GateDecisionItem {
  kind: "gate_decision";
  llmVisible: false;
  action: "continue" | "wait" | "skip" | "topic_switch";
  reason: string | null;
  waitPassCount?: number;
  replyDecision?: "reply_small" | "reply_large" | "wait" | "ignore";
  topicDecision?: string;
  timestampMs: number;
}

export interface SystemMarkerItem {
  kind: "system_marker";
  llmVisible: false;
  timestampMs: number;
  markerType: string;
  content: string;
}

export interface FallbackEventItem {
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

export interface InternalTriggerEventItem {
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

export type TranscriptItem =
  | UserMessageItem
  | AssistantMessageItem
  | AssistantToolCallItem
  | ToolResultItem
  | OutboundMediaMessageItem
  | DirectCommandItem
  | StatusMessageItem
  | GateDecisionItem
  | SystemMarkerItem
  | FallbackEventItem
  | InternalTriggerEventItem;

// ── SSE event types ───────────────────────────────────────────────────────────

export type SessionPhase =
  | { kind: "idle"; label: string }
  | { kind: "waiting"; label: string; pendingMessageCount: number }
  | { kind: "reply_gate_wait"; label: string; pendingMessageCount: number; waitPassCount: number }
  | { kind: "generating"; label: string }
  | { kind: "tool_calling"; label: string; toolNames: string[]; lastToolName: string | null }
  | { kind: "responding"; label: string; previewText: string | null };

export type SessionStreamEvent =
  | { type: "ready";   sessionId: string; mutationEpoch: number; transcriptCount: number; pendingMessageCount: number; isGenerating: boolean; lastActiveAt: number; phase: SessionPhase; timestampMs: number }
  | {
      type: "reset";
      sessionId: string;
      mutationEpoch: number;
      transcriptCount: number;
      pendingMessageCount: number;
      isGenerating: boolean;
      lastActiveAt: number;
      phase: SessionPhase;
      reason: "mutation_epoch_changed" | "transcript_cursor_ahead" | "transcript_gap_detected";
      timestampMs: number;
    }
  | { type: "status";  sessionId: string; mutationEpoch: number; pendingMessageCount: number; isGenerating: boolean; lastActiveAt: number; phase: SessionPhase; timestampMs: number }
  | { type: "transcript_item"; sessionId: string; mutationEpoch: number; index: number; totalCount: number; eventId: string; item: TranscriptItem; timestampMs: number }
  | { type: "session_error"; message: string };

export type TurnStreamEvent =
  | { type: "ready";    turnId: string; sessionId: string; timestampMs: number }
  | { type: "chunk";    turnId: string; sessionId: string; chunk: string; timestampMs: number }
  | { type: "complete"; turnId: string; sessionId: string; response: string; chunks: string[]; timestampMs: number }
  | { type: "turn_error"; turnId: string; sessionId: string; message: string; timestampMs: number };
