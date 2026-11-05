import { mediaDeliveryStatusSchema, mediaDeliveryErrorSchema } from "./mediaDelivery.ts";
import { z } from "zod";
import type { PersistedMessageContentPart } from "#messages/contentParts.ts";
import { chatAttachmentSchema, chatFileKindValues } from "../../types/chatContracts.ts";

export const transcriptItemRuntimeExclusionReasonValues = ["history_compressed", "manual_single", "manual_group", "manual_truncate_after", "interrupt_cleanup", "system"] as const;
export const transcriptSystemMarkerKindValues = [
  "debug_enabled",
  "debug_disabled",
  "debug_once_armed",
  "debug_once_consumed",
  "debug_dump_sent"
] as const;
export const transcriptProfilePhaseTransitionTargetValues = ["persona", "rp", "scenario"] as const;
export const transcriptProfilePhaseTransitionPhaseValues = ["setup", "config"] as const;
export const transcriptProfilePhaseTransitionActionValues = ["enter", "exit_confirmed", "exit_cancelled"] as const;
export const transcriptProfilePhaseTransitionSourceValues = ["command", "automatic"] as const;
export const transcriptOutboundMediaToolNameValues = ["asset_send_to_chat", "filesystem_send_to_chat", "sticker_send"] as const;
export const transcriptInternalTriggerKindValues = [
  "scheduled_instruction",
  "comfy_task_completed",
  "comfy_task_failed",
  "download_completed",
  "download_failed",
  "terminal_session_closed",
  "terminal_input_required"
] as const;
export const transcriptInternalTriggerStageValues = ["received", "queued", "queued_inline", "dequeued", "inlined", "started"] as const;
export const transcriptContextExtractionStatusValues = ["queued", "enqueue_failed", "processed", "process_failed"] as const;
export const transcriptContextExtractionOperationValues = ["noop", "create", "update_existing", "invalidate_and_create", "merge", "ignore_wrong_scope"] as const;
export const transcriptContextExtractionItemResultValues = ["created", "replaced", "ignored", "proposed"] as const;

export const storedToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string()
  }),
  providerMetadata: z.record(z.string(), z.unknown()).optional()
});

// Native message identifiers stay opaque; only the OneBot connector uses numeric IDs.
const platformMessageRefSchema = z.discriminatedUnion("platform", [
  z.object({ platform: z.literal("onebot"), messageId: z.number().int().nonnegative() }),
  z.object({
    platform: z.literal("qq_official"),
    connectionId: z.string().min(1),
    messageId: z.string().min(1)
  })
]);
export const transcriptItemDeliveryRefSchema = platformMessageRefSchema;
export const transcriptItemSourceRefSchema = z.discriminatedUnion("platform", [
  z.object({ platform: z.literal("onebot"), messageId: z.number().int().nonnegative() }),
  z.object({ platform: z.literal("qq_official"), connectionId: z.string().min(1), messageId: z.string().min(1), referenceId: z.string().min(1).max(160).optional() })
]);

export const transcriptSpecialSegmentSchema = z.object({
  type: z.string().min(1),
  summary: z.string()
});

export const transcriptMessageFileSchema = z.object({
  fileId: z.string().min(1),
  name: z.string().nullable(),
  busid: z.union([z.string(), z.number()]).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  mimeType: z.string().nullable(),
  downloadTool: z.literal("download_message_file")
});

// Validate the whole forest before recursive parsing, so sibling subtrees share one budget.
const rawTranscriptMessageContentPartSchema: z.ZodType<PersistedMessageContentPart> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string()
  }),
  z.object({
    kind: z.literal("image"),
    mediaRef: z.string().regex(/^media_[a-f0-9]{32}$/).optional(),
    source: z.string().min(1).optional(),
    fileId: z.string().min(1).optional(),
    sourceName: z.string().nullable().optional(),
    mimeType: z.string().nullable().optional()
  }),
  z.object({
    kind: z.literal("emoji"),
    mediaRef: z.string().regex(/^media_[a-f0-9]{32}$/).optional(),
    source: z.string().min(1).optional(),
    fileId: z.string().min(1).optional(),
    sourceName: z.string().nullable().optional(),
    mimeType: z.string().nullable().optional()
  }),
  z.object({
    kind: z.literal("file"),
    file: transcriptMessageFileSchema
  }),
  z.object({
    kind: z.literal("pending_media"), mediaRef: z.string().regex(/^media_[a-f0-9]{32}$/),
    mediaKind: z.enum(["image", "emoji", "file", "video"]), sourceName: z.string().nullable()
  }),
  z.object({
    kind: z.literal("asset_file"),
    mediaRef: z.string().regex(/^media_[a-f0-9]{32}$/).optional(),
    fileId: z.string().min(1),
    fileKind: z.enum(chatFileKindValues),
    sourceName: z.string().nullable(),
    mimeType: z.string().nullable(),
    sizeBytes: z.number().int().nonnegative().nullable()
  }),
  z.object({
    kind: z.literal("mention"),
    target: z.enum(["self", "all", "user"]),
    userId: z.string().min(1).optional()
  }),
  z.object({
    kind: z.literal("reply"),
    messageId: z.string().min(1)
  }),
  z.object({
    kind: z.literal("forward"),
    forwardId: z.string().min(1),
    recordRef: z.string().regex(/^onebot_[A-Za-z0-9_-]{1,400}$/).optional()
  }),
  z.object({
    kind: z.literal("audio"),
    source: z.string().min(1).optional(),
    audioId: z.string().min(1).optional()
  }),
  z.object({
    kind: z.literal("special"),
    segmentType: z.string().min(1),
    summary: z.string()
  }),
  z.object({
    kind: z.literal("embedded_message"),
    relation: z.enum(["reply", "forward", "message"]),
    recordRef: z.string().regex(/^record_[a-f0-9]{32}$/).optional(),
    recordMessageCount: z.number().int().nonnegative().optional(),
    messageId: z.string().min(1).optional(),
    senderId: z.string().min(1).optional(),
    senderName: z.string().optional(),
    parts: z.array(rawTranscriptMessageContentPartSchema),
    truncated: z.boolean().optional()
  })
]));

// Remote files are ingress-only. Persist imported assets or safe failure markers instead.
export const transcriptMessageContentPartSchema: z.ZodType<PersistedMessageContentPart> = z.preprocess((value, context) => {
  if (!isBoundedContentPartForest([value])) {
    context.addIssue({ code: "custom", message: "嵌入消息超出层级或节点限制，或包含循环结构" });
    return z.NEVER;
  }
  return value;
}, rawTranscriptMessageContentPartSchema);

export const transcriptMessageContentPartsSchema: z.ZodType<PersistedMessageContentPart[]> = z.preprocess((value, context) => {
  if (Array.isArray(value) && !isBoundedContentPartForest(value)) {
    context.addIssue({ code: "custom", message: "嵌入消息超出层级或节点限制，或包含循环结构" });
    return z.NEVER;
  }
  return value;
}, z.array(rawTranscriptMessageContentPartSchema));

function isBoundedContentPartForest(values: readonly unknown[]): boolean {
  const pending: Array<{ value: unknown; depth: number; ancestors: ReadonlySet<object> }> = values.map(value => ({ value, depth: 0, ancestors: new Set<object>() }));
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (++count > 512 || current.depth > 8) return false;
    if (current.value == null || typeof current.value !== "object" || Array.isArray(current.value)) continue;
    if (current.ancestors.has(current.value)) return false;
    const part = current.value as Record<string, unknown>;
    if (part.kind !== "embedded_message" || !Array.isArray(part.parts)) continue;
    const ancestors = new Set(current.ancestors).add(current.value);
    for (const child of part.parts) pending.push({ value: child, depth: current.depth + 1, ancestors });
  }
  return true;
}

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
  subjectKind: z.enum(["text", "image", "emoji", "audio", "audio_transcript", "file", "local_media"]),
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
  contentParts: transcriptMessageContentPartsSchema.optional(),
  imageIds: z.array(z.string()).default([]),
  emojiIds: z.array(z.string()).default([]),
  attachments: z.array(chatAttachmentSchema).default([]),
  messageFiles: z.array(transcriptMessageFileSchema).default([]),
  specialSegments: z.array(transcriptSpecialSegmentSchema).optional(),
  audioCount: z.number().int().nonnegative(),
  forwardIds: z.array(z.string()).default([]),
  replyMessageId: z.string().nullable(),
  mentionUserIds: z.array(z.string()).default([]),
  mentionedAll: z.boolean(),
  mentionedSelf: z.boolean(),
  timestampMs: z.number().int().nonnegative()
});

export const transcriptUserMediaMessageItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("user_media_message"),
  role: z.literal("user"),
  llmVisible: z.literal(true),
  chatType: z.enum(["private", "group"]),
  userId: z.string().min(1),
  senderName: z.string().min(1),
  mediaKind: z.enum(["image", "emoji", "mixed"]),
  contentParts: transcriptMessageContentPartsSchema.default([]),
  imageIds: z.array(z.string()).default([]),
  emojiIds: z.array(z.string()).default([]),
  attachments: z.array(chatAttachmentSchema).default([]),
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
  providerMetadata: z.record(z.string(), z.unknown()).optional(),
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

export const transcriptProfilePhaseTransitionItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("profile_phase_transition"),
  role: z.literal("assistant"),
  llmVisible: z.literal(true),
  target: z.enum(transcriptProfilePhaseTransitionTargetValues),
  phase: z.enum(transcriptProfilePhaseTransitionPhaseValues),
  action: z.enum(transcriptProfilePhaseTransitionActionValues),
  source: z.enum(transcriptProfilePhaseTransitionSourceValues),
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
    kind: z.enum(["filesystem", "shell_session", "browser_page", "asset", "search_result", "external"]),
    id: z.string().min(1),
    locator: z.string().optional(),
    version: z.string().optional()
  }).optional(),
  replaySafe: z.boolean(),
  refetchable: z.boolean(),
  pinned: z.boolean(),
  preserveRecentRawCount: z.number().int().nonnegative().optional(),
  includeInHistorySummary: z.boolean().optional(),
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
  canonicalContent: z.string().optional(),
  observation: transcriptToolObservationSchema.optional()
});

export const transcriptOutboundMediaMessageItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("outbound_media_message"),
  llmVisible: z.literal(false),
  role: z.literal("assistant"),
  delivery: z.enum(["onebot", "qq_official", "web"]),
  mediaKind: z.enum(["image", "emoji", "audio", "file"]),
  deliveryStatus: mediaDeliveryStatusSchema,
  deliveryUpdatedAtMs: z.number().int().nonnegative(),
  deliveryError: mediaDeliveryErrorSchema.optional(),
  aiGenerated: z.boolean().optional(),
  fileId: z.string().min(1).nullable(),
  fileRef: z.string().nullable(),
  sourceName: z.string().nullable(),
  chatFilePath: z.string().nullable(),
  sourcePath: z.string().nullable(),
  mimeType: z.string().nullable().optional(),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
  messageId: z.union([z.number().int().nonnegative(), z.string().min(1)]).nullable(),
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
  replyDecision: z.enum(["reply", "reply_small", "reply_large", "wait", "no_reply", "ignore"]).optional(),
  topicDecision: z.string().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
  contextDependencies: z.array(z.string()).optional(),
  recentDomainReuse: z.array(z.string()).optional(),
  followupMode: z.string().optional(),
  toolsetIds: z.array(z.string()).optional(),
  plannerReasons: z.array(z.string()).optional(),
  plannerMetrics: z.object({
    backend: z.enum(["chat", "decision"]).optional(),
    modelRef: z.string().optional(),
    fallbackReason: z.enum(["decision_failed", "question_limit"]).optional(),
    durationMs: z.number().nonnegative(),
    mediaPreparationMs: z.number().nonnegative(),
    generationMs: z.number().nonnegative(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    cachedTokens: z.number().nullable(),
    mediaCaptionCount: z.number().nonnegative(),
    emojiInputCount: z.number().nonnegative(),
    imageInputCount: z.number().nonnegative().optional()
  }).optional(),
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

export const transcriptModelRouteEventItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("model_route_event"),
  llmVisible: z.literal(false),
  timestampMs: z.number().int().nonnegative(),
  routeType: z.literal("self_upgrade"),
  fromRole: z.literal("main_small"),
  toRole: z.literal("main_large"),
  title: z.string(),
  summary: z.string(),
  reason: z.string(),
  fromModelRefs: z.array(z.string().min(1)).min(1),
  toModelRefs: z.array(z.string().min(1)).min(1),
  provider: z.string().min(1)
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

export const transcriptContextExtractionEventItemSchema = z.object({
  ...transcriptItemMetaSchema.shape,
  kind: z.literal("context_extraction_event"),
  llmVisible: z.literal(false),
  timestampMs: z.number().int().nonnegative(),
  status: z.enum(transcriptContextExtractionStatusValues),
  title: z.string(),
  summary: z.string(),
  targetUserIds: z.array(z.string().min(1)),
  messageCount: z.number().int().nonnegative(),
  created: z.number().int().nonnegative().optional(),
  replaced: z.number().int().nonnegative().optional(),
  ignored: z.number().int().nonnegative().optional(),
  items: z.array(z.object({
    result: z.enum(transcriptContextExtractionItemResultValues),
    scope: z.enum(["session", "user", "global", "toolset", "mode"]).optional(),
    operation: z.enum(transcriptContextExtractionOperationValues).optional(),
    memoryId: z.string().min(1).optional(),
    targetMemoryIds: z.array(z.string().min(1)).optional(),
    slotKey: z.string().min(1).optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    kind: z.enum(["preference", "fact", "boundary", "habit", "relationship", "other"]).optional(),
    reason: z.string().optional()
  })).optional(),
  details: z.string().optional(),
  errorMessage: z.string().optional()
});

export const internalTranscriptItemSchema = z.discriminatedUnion("kind", [
  transcriptUserMessageItemSchema,
  transcriptUserMediaMessageItemSchema,
  transcriptAssistantMessageItemSchema,
  transcriptSessionModeSwitchItemSchema,
  transcriptProfilePhaseTransitionItemSchema,
  transcriptAssistantToolCallItemSchema,
  transcriptToolResultItemSchema,
  transcriptOutboundMediaMessageItemSchema,
  transcriptDirectCommandItemSchema,
  transcriptStatusMessageItemSchema,
  transcriptGateDecisionItemSchema,
  transcriptSystemMarkerItemSchema,
  transcriptFallbackEventItemSchema,
  transcriptModelRouteEventItemSchema,
  transcriptInternalTriggerEventItemSchema,
  transcriptTitleGenerationItemSchema,
  transcriptContextExtractionEventItemSchema
]);

export const transcriptUserMessagePatchSchema = z.object({
  groupId: transcriptItemMetaSchema.shape.groupId,
  chatType: transcriptUserMessageItemSchema.shape.chatType.optional(),
  userId: transcriptUserMessageItemSchema.shape.userId.optional(),
  senderName: transcriptUserMessageItemSchema.shape.senderName.optional(),
  text: z.string().optional(),
  contentParts: transcriptMessageContentPartsSchema.optional(),
  imageIds: z.array(z.string()).optional(),
  emojiIds: z.array(z.string()).optional(),
  attachments: z.array(chatAttachmentSchema).optional(),
  messageFiles: z.array(transcriptMessageFileSchema).optional(),
  specialSegments: z.array(transcriptSpecialSegmentSchema).optional(),
  audioCount: transcriptUserMessageItemSchema.shape.audioCount.optional(),
  forwardIds: z.array(z.string()).optional(),
  replyMessageId: transcriptUserMessageItemSchema.shape.replyMessageId.optional(),
  mentionUserIds: z.array(z.string()).optional(),
  mentionedAll: z.boolean().optional(),
  mentionedSelf: z.boolean().optional(),
  sourceRef: transcriptItemSourceRefSchema.optional(),
  contentSafetyEvents: z.array(transcriptContentSafetyEventSchema).optional()
});

export const transcriptItemPatchSchema = z.object({
  deliveryStatus: mediaDeliveryStatusSchema.optional(),
  deliveryUpdatedAtMs: z.number().int().nonnegative().optional(),
  deliveryError: mediaDeliveryErrorSchema.optional(),
  messageId: z.union([z.number().int().nonnegative(), z.string().min(1)]).nullable().optional(),
  ...transcriptUserMessagePatchSchema.shape,
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
export type TranscriptMessageContentPart = z.infer<typeof transcriptMessageContentPartSchema>;
export type TranscriptContentSafetyEvent = z.infer<typeof transcriptContentSafetyEventSchema>;
export type TranscriptItemMeta = z.infer<typeof transcriptItemMetaSchema>;
export type InternalTranscriptItem = z.infer<typeof internalTranscriptItemSchema>;
export type NormalizedInternalTranscriptItem = InternalTranscriptItem & {
  id: string;
  groupId: string;
  runtimeExcluded: boolean;
};
export type TranscriptItemPatch = z.infer<typeof transcriptItemPatchSchema>;
