import { z } from "zod";
import { chatAttachmentSchema } from "../../types/chatContracts.ts";

export const transcriptItemRuntimeExclusionReasonValues = ["manual_single", "manual_group", "interrupt_cleanup", "system"] as const;
export const transcriptSystemMarkerKindValues = [
  "debug_enabled",
  "debug_disabled",
  "debug_once_armed",
  "debug_once_consumed",
  "debug_dump_sent"
] as const;
export const transcriptOutboundMediaToolNameValues = ["chat_file_send_to_chat", "local_file_send_to_chat"] as const;
export const transcriptInternalTriggerKindValues = [
  "scheduled_instruction",
  "comfy_task_completed",
  "comfy_task_failed",
  "terminal_session_closed",
  "terminal_input_required"
] as const;
export const transcriptInternalTriggerStageValues = ["received", "queued", "dequeued", "started"] as const;

export const storedToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string()
  }),
  providerMetadata: z.record(z.string(), z.unknown()).optional()
});

export const transcriptItemDeliveryRefSchema = z.object({
  platform: z.literal("onebot"),
  messageId: z.number().int().nonnegative()
});

export const transcriptItemSourceRefSchema = z.object({
  platform: z.literal("onebot"),
  messageId: z.number().int().nonnegative()
});

export const transcriptSpecialSegmentSchema = z.object({
  type: z.string().min(1),
  summary: z.string()
});

export const transcriptTokenStatSourceValues = ["api_direct", "api_attributed", "estimated"] as const;

export const transcriptTokenStatSchema = z.object({
  tokens: z.number().int().nonnegative(),
  source: z.enum(transcriptTokenStatSourceValues),
  modelRef: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  providerReported: z.boolean().optional(),
  sampleCount: z.number().int().positive().default(1),
  updatedAt: z.number().int().nonnegative()
});

export const transcriptTokenStatsSchema = z.object({
  input: transcriptTokenStatSchema.optional(),
  output: transcriptTokenStatSchema.optional(),
  reasoning: transcriptTokenStatSchema.optional()
});

export const transcriptContentSafetyEventSchema = z.object({
  subjectKind: z.enum(["text", "image", "emoji", "audio_transcript", "file", "local_media"]),
  decision: z.enum(["allow", "review", "block", "error"]),
  marker: z.string().nullable(),
  auditKey: z.string().min(1).nullable(),
  fileId: z.string().min(1).optional(),
  audioId: z.string().min(1).optional(),
  contentHash: z.string().min(1).optional(),
  reason: z.string()
});

export const transcriptItemMetaSchema = z.object({
  id: z.string().min(1).optional(),
  groupId: z.string().min(1).optional(),
  runtimeExcluded: z.boolean().optional(),
  runtimeExcludedAt: z.number().int().nonnegative().optional(),
  runtimeExclusionReason: z.enum(transcriptItemRuntimeExclusionReasonValues).optional(),
  sourceRef: transcriptItemSourceRefSchema.optional(),
  deliveryRef: transcriptItemDeliveryRefSchema.optional(),
  contentSafetyEvents: z.array(transcriptContentSafetyEventSchema).optional(),
  tokenStats: transcriptTokenStatsSchema.optional()
});

export const transcriptUserMessageItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("user_message"),
  role: z.literal("user"),
  llmVisible: z.literal(true),
  chatType: z.enum(["private", "group"]),
  userId: z.string().min(1),
  senderName: z.string().min(1),
  text: z.string(),
  imageIds: z.array(z.string()).default([]),
  emojiIds: z.array(z.string()).default([]),
  attachments: z.array(chatAttachmentSchema).default([]),
  specialSegments: z.array(transcriptSpecialSegmentSchema).optional(),
  audioCount: z.number().int().nonnegative(),
  forwardIds: z.array(z.string()).default([]),
  replyMessageId: z.string().nullable(),
  mentionUserIds: z.array(z.string()).default([]),
  mentionedAll: z.boolean(),
  mentionedSelf: z.boolean(),
  timestampMs: z.number().int().nonnegative()
});

export const transcriptAssistantMessageItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("assistant_message"),
  role: z.literal("assistant"),
  llmVisible: z.literal(true),
  chatType: z.enum(["private", "group"]),
  userId: z.string().min(1),
  senderName: z.string().min(1),
  text: z.string(),
  reasoningContent: z.string().optional(),
  timestampMs: z.number().int().nonnegative()
});

export const transcriptSessionModeSwitchItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("session_mode_switch"),
  role: z.literal("assistant"),
  llmVisible: z.literal(true),
  fromModeId: z.string().min(1),
  toModeId: z.string().min(1),
  content: z.string(),
  timestampMs: z.number().int().nonnegative()
});

export const transcriptAssistantToolCallItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("assistant_tool_call"),
  llmVisible: z.literal(true),
  timestampMs: z.number().int().nonnegative(),
  content: z.string(),
  toolCalls: z.array(storedToolCallSchema),
  reasoningContent: z.string().optional(),
  providerMetadata: z.record(z.string(), z.unknown()).optional()
});

export const transcriptToolObservationSchema = z.object({
  contentHash: z.string().min(1),
  inputTokensEstimate: z.number().int().nonnegative(),
  summary: z.string(),
  retention: z.enum(["full", "summary", "handle", "omitted"]),
  replayContent: z.string(),
  resource: z.object({
    kind: z.enum(["local_file", "shell_session", "browser_page", "chat_file", "search_result", "external"]),
    id: z.string().min(1),
    locator: z.string().optional(),
    version: z.string().optional()
  }).optional(),
  replaySafe: z.boolean(),
  refetchable: z.boolean(),
  pinned: z.boolean(),
  duplicateOfToolCallId: z.string().min(1).optional()
});

export const transcriptToolResultItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("tool_result"),
  llmVisible: z.literal(true),
  timestampMs: z.number().int().nonnegative(),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  content: z.string(),
  observation: transcriptToolObservationSchema.optional()
});

export const transcriptOutboundMediaMessageItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("outbound_media_message"),
  llmVisible: z.literal(false),
  role: z.literal("assistant"),
  delivery: z.enum(["onebot", "web"]),
  mediaKind: z.literal("image"),
  fileId: z.string().min(1).nullable(),
  fileRef: z.string().nullable(),
  sourceName: z.string().nullable(),
  chatFilePath: z.string().nullable(),
  sourcePath: z.string().nullable(),
  messageId: z.number().int().nonnegative().nullable(),
  toolName: z.enum(transcriptOutboundMediaToolNameValues),
  captionText: z.string().nullable().optional(),
  timestampMs: z.number().int().nonnegative()
});

export const transcriptDirectCommandItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("direct_command"),
  llmVisible: z.literal(false),
  direction: z.enum(["input", "output"]),
  role: z.enum(["user", "assistant"]),
  commandName: z.string().min(1),
  content: z.string(),
  timestampMs: z.number().int().nonnegative()
});

export const transcriptStatusMessageItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("status_message"),
  llmVisible: z.literal(false),
  role: z.literal("assistant"),
  statusType: z.enum(["system", "command"]),
  content: z.string(),
  timestampMs: z.number().int().nonnegative()
});

export const transcriptGateDecisionItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("gate_decision"),
  llmVisible: z.literal(false),
  action: z.enum(["continue", "wait", "skip", "topic_switch"]),
  reason: z.string().nullable(),
  reasoningContent: z.string().optional(),
  waitPassCount: z.number().int().nonnegative().optional(),
  replyDecision: z.enum(["reply_small", "reply_large", "wait", "ignore"]).optional(),
  topicDecision: z.string().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
  contextDependencies: z.array(z.string()).optional(),
  recentDomainReuse: z.array(z.string()).optional(),
  followupMode: z.string().optional(),
  toolsetIds: z.array(z.string()).optional(),
  timestampMs: z.number().int().nonnegative()
});

export const transcriptSystemMarkerItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("system_marker"),
  llmVisible: z.literal(false),
  timestampMs: z.number().int().nonnegative(),
  markerType: z.enum(transcriptSystemMarkerKindValues),
  content: z.string()
});

export const transcriptFallbackEventItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("fallback_event"),
  llmVisible: z.literal(false),
  timestampMs: z.number().int().nonnegative(),
  fallbackType: z.enum(["model_candidate_switch", "generation_failure_reply"]),
  title: z.string(),
  summary: z.string(),
  details: z.string(),
  fromModelRef: z.string().optional(),
  toModelRef: z.string().optional(),
  fromProvider: z.string().optional(),
  toProvider: z.string().optional(),
  failureMessage: z.string().optional()
});

export const transcriptInternalTriggerEventItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("internal_trigger_event"),
  llmVisible: z.literal(false),
  timestampMs: z.number().int().nonnegative(),
  triggerKind: z.enum(transcriptInternalTriggerKindValues),
  stage: z.enum(transcriptInternalTriggerStageValues),
  title: z.string(),
  summary: z.string(),
  jobName: z.string().min(1),
  targetType: z.enum(["private", "group"]),
  targetUserId: z.string().optional(),
  targetGroupId: z.string().optional(),
  taskId: z.string().optional(),
  templateId: z.string().optional(),
  comfyPromptId: z.string().optional(),
  autoIterationIndex: z.number().int().nonnegative().optional(),
  maxAutoIterations: z.number().int().nonnegative().optional(),
  resourceId: z.string().optional(),
  details: z.string().optional()
});

export const transcriptTitleGenerationItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("title_generation_event"),
  llmVisible: z.literal(false),
  timestampMs: z.number().int().nonnegative(),
  source: z.enum(["auto", "regenerate"]),
  modeId: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  details: z.string()
});

export const internalTranscriptItemSchema = z.discriminatedUnion("kind", [
  transcriptUserMessageItemSchema,
  transcriptAssistantMessageItemSchema,
  transcriptSessionModeSwitchItemSchema,
  transcriptAssistantToolCallItemSchema,
  transcriptToolResultItemSchema,
  transcriptOutboundMediaMessageItemSchema,
  transcriptDirectCommandItemSchema,
  transcriptStatusMessageItemSchema,
  transcriptGateDecisionItemSchema,
  transcriptSystemMarkerItemSchema,
  transcriptFallbackEventItemSchema,
  transcriptInternalTriggerEventItemSchema,
  transcriptTitleGenerationItemSchema
]);

export const transcriptItemPatchSchema = z.object({
  reasoningContent: z.string().optional(),
  runtimeExcluded: z.boolean().optional(),
  runtimeExcludedAt: z.number().int().nonnegative().optional(),
  runtimeExclusionReason: z.enum(transcriptItemRuntimeExclusionReasonValues).optional(),
  tokenStats: transcriptTokenStatsSchema.optional()
});

export type StoredToolCall = z.infer<typeof storedToolCallSchema>;
export type TranscriptTokenStatSource = (typeof transcriptTokenStatSourceValues)[number];
export type TranscriptTokenStat = z.infer<typeof transcriptTokenStatSchema>;
export type TranscriptTokenStats = z.infer<typeof transcriptTokenStatsSchema>;
export type TranscriptToolObservation = z.infer<typeof transcriptToolObservationSchema>;
export type TranscriptItemRuntimeExclusionReason = (typeof transcriptItemRuntimeExclusionReasonValues)[number];
export type TranscriptItemSourceRef = z.infer<typeof transcriptItemSourceRefSchema>;
export type TranscriptItemDeliveryRef = z.infer<typeof transcriptItemDeliveryRefSchema>;
export type TranscriptContentSafetyEvent = z.infer<typeof transcriptContentSafetyEventSchema>;
export type TranscriptItemMeta = z.infer<typeof transcriptItemMetaSchema>;
export type InternalTranscriptItem = z.infer<typeof internalTranscriptItemSchema>;
export type NormalizedInternalTranscriptItem = InternalTranscriptItem & {
  id: string;
  groupId: string;
  runtimeExcluded: boolean;
};
export type TranscriptItemPatch = z.infer<typeof transcriptItemPatchSchema>;
