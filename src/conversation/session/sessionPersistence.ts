import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { PersistedSessionState } from "./sessionManager.ts";
import { getDefaultSessionModeId } from "#modes/registry.ts";
import { createNormalSessionOperationMode } from "./sessionOperationMode.ts";
import { chatAttachmentSchema } from "#types/chatContracts.ts";
import { internalTranscriptItemSchema } from "./transcriptContract.ts";

const personaDraftSchema = z.object({
  name: z.string(),
  temperament: z.string(),
  speakingStyle: z.string(),
  globalTraits: z.string(),
  generalPreferences: z.string()
});

const rpProfileDraftSchema = z.object({
  selfPositioning: z.string(),
  socialRole: z.string(),
  lifeContext: z.string(),
  physicalPresence: z.string(),
  bondToUser: z.string(),
  closenessPattern: z.string(),
  interactionPattern: z.string(),
  realityContract: z.string(),
  continuityFacts: z.string(),
  hardLimits: z.string()
});

const scenarioProfileDraftSchema = z.object({
  theme: z.string(),
  hostStyle: z.string(),
  worldBaseline: z.string(),
  safetyOrTabooRules: z.string(),
  openingPattern: z.string()
});

const sessionOperationModeSchema = z.union([
  z.object({
    kind: z.literal("normal")
  }),
  z.object({
    kind: z.literal("persona_setup"),
    draft: personaDraftSchema
  }),
  z.object({
    kind: z.literal("mode_setup"),
    modeId: z.literal("rp_assistant"),
    draft: rpProfileDraftSchema
  }),
  z.object({
    kind: z.literal("mode_setup"),
    modeId: z.literal("scenario_host"),
    draft: scenarioProfileDraftSchema
  }),
  z.object({
    kind: z.literal("persona_config"),
    draft: personaDraftSchema
  }),
  z.object({
    kind: z.literal("mode_config"),
    modeId: z.literal("rp_assistant"),
    draft: rpProfileDraftSchema
  }),
  z.object({
    kind: z.literal("mode_config"),
    modeId: z.literal("scenario_host"),
    draft: scenarioProfileDraftSchema
  })
]);

const persistedSessionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["private", "group"]),
  source: z.enum(["onebot", "web"]).default("onebot"),
  modeId: z.string().min(1).default(getDefaultSessionModeId()),
  operationMode: sessionOperationModeSchema.default(createNormalSessionOperationMode()),
  participantRef: z.object({
    kind: z.enum(["user", "group"]),
    id: z.string().min(1)
  }),
  title: z.string().nullable(),
  titleSource: z.enum(["default", "auto", "manual"]).nullable(),
  replyDelivery: z.enum(["onebot", "web"]).default("onebot"),
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
    attachments: z.array(chatAttachmentSchema).default([]),
    specialSegments: z.array(z.object({
      type: z.string().min(1),
      summary: z.string()
    })).optional(),
    forwardIds: z.array(z.string()),
    replyMessageId: z.string().nullable(),
    mentionUserIds: z.array(z.string()),
    mentionedAll: z.boolean(),
    isAtMentioned: z.boolean(),
    rawEvent: z.any().optional(),
    receivedAt: z.number().int().nonnegative()
  })),
  pendingTranscriptGroupId: z.string().min(1).nullable().optional(),
  activeTranscriptGroupId: z.string().min(1).nullable().optional(),
  historySummary: z.string().nullable(),
  historyBackfillBoundaryMs: z.number().int().nonnegative().optional(),
  internalTranscript: z.array(internalTranscriptItemSchema),
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
      "live_resources",
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
