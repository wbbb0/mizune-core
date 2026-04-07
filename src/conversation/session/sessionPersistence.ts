import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { PersistedSessionState } from "./sessionManager.ts";

const persistedSessionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["private", "group"]),
  lastInboundDelivery: z.enum(["onebot", "web"]).default("onebot"),
  pendingMessages: z.array(z.object({
    userId: z.string().min(1),
    groupId: z.string().min(1).optional(),
    senderName: z.string().min(1),
    chatType: z.enum(["private", "group"]),
    text: z.string(),
    images: z.array(z.string()),
    audioSources: z.array(z.string()).default([]),
    audioIds: z.array(z.string()).default([]),
    emojiSources: z.array(z.string()),
    imageIds: z.array(z.string()),
    emojiIds: z.array(z.string()),
    attachments: z.array(z.object({
      assetId: z.string(),
      kind: z.enum(["image", "file", "audio"]),
      source: z.enum(["chat_message", "web_upload", "browser", "workspace"]),
      filename: z.string().nullable(),
      mimeType: z.string().nullable()
    })).default([]),
    forwardIds: z.array(z.string()),
    replyMessageId: z.string().nullable(),
    mentionUserIds: z.array(z.string()),
    mentionedAll: z.boolean(),
    isAtMentioned: z.boolean(),
    rawEvent: z.any().optional(),
    receivedAt: z.number().int().nonnegative()
  })),
  historySummary: z.string().nullable(),
  internalTranscript: z.array(z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("user_message"),
      role: z.literal("user"),
      llmVisible: z.literal(true),
      chatType: z.enum(["private", "group"]),
      userId: z.string().min(1),
      senderName: z.string().min(1),
      text: z.string(),
      imageIds: z.array(z.string()).default([]),
      emojiIds: z.array(z.string()).default([]),
      attachments: z.array(z.object({
        assetId: z.string(),
        kind: z.enum(["image", "animated_image", "video", "audio", "file"]),
        source: z.enum(["chat_message", "web_upload", "browser", "workspace"]),
        filename: z.string().nullable(),
        mimeType: z.string().nullable(),
        semanticKind: z.enum(["image", "emoji"]).optional()
      })).default([]),
      audioCount: z.number().int().nonnegative(),
      forwardIds: z.array(z.string()).default([]),
      replyMessageId: z.string().nullable(),
      mentionUserIds: z.array(z.string()).default([]),
      mentionedAll: z.boolean(),
      mentionedSelf: z.boolean(),
      timestampMs: z.number().int().nonnegative()
    }),
    z.object({
      kind: z.literal("assistant_message"),
      role: z.literal("assistant"),
      llmVisible: z.literal(true),
      chatType: z.enum(["private", "group"]),
      userId: z.string().min(1),
      senderName: z.string().min(1),
      text: z.string(),
      timestampMs: z.number().int().nonnegative()
    }),
    z.object({
      kind: z.literal("assistant_tool_call"),
      llmVisible: z.literal(true),
      timestampMs: z.number().int().nonnegative(),
      content: z.string(),
      toolCalls: z.array(z.object({
        id: z.string().min(1),
        type: z.literal("function"),
        function: z.object({
          name: z.string().min(1),
          arguments: z.string()
        }),
        providerMetadata: z.record(z.string(), z.unknown()).optional()
      })),
      reasoningContent: z.string().optional(),
      providerMetadata: z.record(z.string(), z.unknown()).optional()
    }),
    z.object({
      kind: z.literal("tool_result"),
      llmVisible: z.literal(true),
      timestampMs: z.number().int().nonnegative(),
      toolCallId: z.string().min(1),
      toolName: z.string().min(1),
      content: z.string()
    }),
    z.object({
      kind: z.literal("outbound_media_message"),
      llmVisible: z.literal(false),
      role: z.literal("assistant"),
      delivery: z.enum(["onebot", "web"]),
      mediaKind: z.literal("image"),
      assetId: z.string().min(1),
      filename: z.string().nullable(),
      messageId: z.number().int().nonnegative().nullable(),
      toolName: z.literal("send_workspace_media_to_chat"),
      captionText: z.string().nullable().optional(),
      timestampMs: z.number().int().nonnegative()
    }),
    z.object({
      kind: z.literal("direct_command"),
      llmVisible: z.literal(false),
      direction: z.enum(["input", "output"]),
      role: z.enum(["user", "assistant"]),
      commandName: z.string().min(1),
      content: z.string(),
      timestampMs: z.number().int().nonnegative()
    }),
    z.object({
      kind: z.literal("status_message"),
      llmVisible: z.literal(false),
      role: z.literal("assistant"),
      statusType: z.enum(["system", "command"]),
      content: z.string(),
      timestampMs: z.number().int().nonnegative()
    }),
    z.object({
      kind: z.literal("gate_decision"),
      llmVisible: z.literal(false),
      action: z.enum(["continue", "wait", "skip", "topic_switch"]),
      reason: z.string().nullable(),
      waitPassCount: z.number().int().nonnegative().optional(),
      replyDecision: z.enum(["reply_small", "reply_large", "wait", "ignore"]).optional(),
      topicDecision: z.string().optional(),
      timestampMs: z.number().int().nonnegative()
    }),
    z.object({
      kind: z.literal("system_marker"),
      llmVisible: z.literal(false),
      timestampMs: z.number().int().nonnegative(),
      markerType: z.enum(["debug_enabled", "debug_disabled", "debug_once_armed", "debug_once_consumed", "debug_dump_sent"]),
      content: z.string()
    }),
    z.object({
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
    }),
    z.object({
      kind: z.literal("internal_trigger_event"),
      llmVisible: z.literal(false),
      timestampMs: z.number().int().nonnegative(),
      triggerKind: z.enum(["scheduled_instruction", "comfy_task_completed", "comfy_task_failed"]),
      stage: z.enum(["received", "queued", "dequeued", "started"]),
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
      details: z.string().optional()
    })
  ])),
  debugMarkers: z.array(z.object({
    kind: z.enum(["debug_enabled", "debug_disabled", "debug_once_armed", "debug_once_consumed", "debug_dump_sent"]),
    timestampMs: z.number().int().nonnegative(),
    literals: z.array(z.enum([
      "full_system_prompt",
      "history_summary",
      "tools_info",
      "image_captions",
      "user_infos",
      "persona",
      "recent_history",
      "current_batch",
      "runtime_resources",
      "debug_markers",
      "last_llm_usage",
      "tool_transcript"
    ])).optional(),
    sentCount: z.number().int().nonnegative().optional(),
    note: z.string().optional()
  })),
  recentToolEvents: z.array(z.object({
    toolName: z.string().min(1),
    argsSummary: z.string(),
    outcome: z.enum(["success", "error"]),
    resultSummary: z.string(),
    timestampMs: z.number().int().nonnegative()
  })),
  lastLlmUsage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    cachedTokens: z.preprocess((value) => value ?? null, z.number().int().nonnegative().nullable()),
    reasoningTokens: z.preprocess((value) => value ?? null, z.number().int().nonnegative().nullable()),
    requestCount: z.number().int().nonnegative(),
    providerReported: z.boolean(),
    modelRef: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    capturedAt: z.number().int().nonnegative()
  }).nullable(),
  sentMessages: z.array(z.object({
    messageId: z.number().int().nonnegative(),
    text: z.string(),
    sentAt: z.number().int().nonnegative()
  })),
  lastActiveAt: z.number().int().nonnegative(),
  lastMessageAt: z.number().int().nonnegative().nullable(),
  latestGapMs: z.number().int().nonnegative().nullable(),
  smoothedGapMs: z.number().nonnegative().nullable()
});

export class SessionPersistence {
  private readonly sessionDir: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    dataDir: string,
    private readonly logger: Logger
  ) {
    this.sessionDir = join(dataDir, "sessions");
  }

  async init(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
  }

  async loadAll(): Promise<PersistedSessionState[]> {
    const fileNames = await readdir(this.sessionDir, { withFileTypes: true });
    const sessions: PersistedSessionState[] = [];

    for (const entry of fileNames) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = join(this.sessionDir, entry.name);
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = persistedSessionSchema.parse(JSON.parse(raw)) as PersistedSessionState;
        sessions.push(parsed);
      } catch (error: unknown) {
        this.logger.warn({ error, filePath }, "session_persist_load_failed");
      }
    }

    sessions.sort((left, right) => left.lastActiveAt - right.lastActiveAt);
    return sessions;
  }

  async save(session: PersistedSessionState): Promise<void> {
    const key = session.id;
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const filePath = this.getFilePath(session.id);
        const tempPath = `${filePath}.tmp`;
        try {
          await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
        } catch (error: unknown) {
          if (isMissingFileError(error)) {
            await mkdir(this.sessionDir, { recursive: true });
            await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
          } else {
            throw error;
          }
        }
        await rename(tempPath, filePath);
      })
      .finally(() => {
        if (this.writes.get(key) === next) {
          this.writes.delete(key);
        }
      });

    this.writes.set(key, next);
    await next;
  }

  async remove(sessionId: string): Promise<void> {
    const filePath = this.getFilePath(sessionId);
    try {
      await unlink(filePath);
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        this.logger.warn({ error, filePath }, "session_persist_remove_failed");
      }
    }
  }

  async getPersistedSessionMtimeMs(sessionId: string): Promise<number | null> {
    try {
      const filePath = this.getFilePath(sessionId);
      return (await stat(filePath)).mtimeMs;
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return null;
      }
      this.logger.warn({ error, sessionId }, "session_persist_stat_failed");
      throw error;
    }
  }

  private getFilePath(sessionId: string): string {
    return join(this.sessionDir, `${encodeURIComponent(sessionId)}.json`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
