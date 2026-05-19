import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { PersistedSessionState } from "./sessionManager.ts";
import { getDefaultSessionModeId } from "#modes/registry.ts";
import { createNormalSessionOperationMode } from "./sessionOperationMode.ts";
import {
  SqliteService,
  type SqliteDatabase,
  type SqliteDatabaseHandle
} from "#data/sqlite/sqliteService.ts";
import { createTableGroupsFromDataDomain, listDataModelRows } from "#data/model/index.ts";
import { chatAttachmentSchema } from "#types/chatContracts.ts";
import { internalTranscriptItemSchema, transcriptMessageContentPartSchema } from "./transcriptContract.ts";
import { sessionDataDomain, sessionsTableModel, sessionTranscriptItemsTableModel } from "./sessionDataModel.ts";

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
    contentParts: z.array(transcriptMessageContentPartSchema).optional(),
    images: z.array(z.string()),
    audioSources: z.array(z.string()).default([]),
    audioIds: z.array(z.string()).default([]),
    emojiSources: z.array(z.string()),
    imageIds: z.array(z.string()),
    emojiIds: z.array(z.string()),
    attachments: z.array(chatAttachmentSchema).default([]),
    messageFiles: z.array(z.object({
      fileId: z.string().min(1),
      name: z.string().nullable(),
      busid: z.union([z.string(), z.number()]).nullable(),
      sizeBytes: z.number().int().nonnegative().nullable(),
      mimeType: z.string().nullable(),
      downloadTool: z.literal("download_message_file")
    })).default([]),
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
  private readonly dbPath: string;
  private sqlite: SqliteDatabaseHandle | null = null;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly sqliteService = new SqliteService(logger)
  ) {
    this.dbPath = join(dataDir, "sessions", "sessions.sqlite");
  }

  async init(): Promise<void> {
    await this.getReadyDb();
  }

  async loadAll(): Promise<PersistedSessionState[]> {
    const db = await this.getReadyDb();
    const rows = db.prepare(`
      SELECT
        session_id,
        type,
        source,
        mode_id,
        operation_mode_json,
        participant_kind,
        participant_id,
        title,
        title_source,
        reply_delivery,
        pending_messages_json,
        pending_transcript_group_id_is_set,
        pending_transcript_group_id,
        active_transcript_group_id_is_set,
        active_transcript_group_id,
        history_summary,
        history_backfill_boundary_ms,
        COALESCE((
          SELECT json_group_array(json(ordered_items.item_json))
          FROM (
            SELECT item_json
            FROM session_transcript_items
            WHERE session_transcript_items.session_id = sessions.session_id
            ORDER BY item_index ASC
          ) AS ordered_items
        ), '[]') AS internal_transcript_json,
        debug_markers_json,
        last_llm_usage_json,
        sent_messages_json,
        last_active_at_ms,
        last_message_at_ms,
        latest_gap_ms,
        smoothed_gap_ms
      FROM sessions
      ORDER BY last_active_at_ms ASC, session_id ASC
    `).all() as PersistedSessionRow[];
    const sessions: PersistedSessionState[] = [];

    for (const row of rows) {
      try {
        sessions.push(rowToPersistedSessionState(row));
      } catch (error: unknown) {
        this.logger.warn({ error, sessionId: row.session_id }, "session_persist_load_failed");
      }
    }

    return sessions;
  }

  async save(session: PersistedSessionState): Promise<void> {
    const validated = persistedSessionSchema.parse(session) as PersistedSessionState;
    await this.enqueueWrite(session.id, async () => {
      const db = await this.getReadyDb();
      const write = db.transaction(() => {
        db.prepare(`
          INSERT INTO sessions (
            session_id,
            type,
            source,
            mode_id,
            operation_mode_json,
            participant_kind,
            participant_id,
            title,
            title_source,
            reply_delivery,
            pending_messages_json,
            pending_transcript_group_id_is_set,
            pending_transcript_group_id,
            active_transcript_group_id_is_set,
            active_transcript_group_id,
            history_summary,
            history_backfill_boundary_ms,
            debug_markers_json,
            last_llm_usage_json,
            sent_messages_json,
            last_active_at_ms,
            last_message_at_ms,
            latest_gap_ms,
            smoothed_gap_ms,
            updated_at_ms
          ) VALUES (
            @sessionId,
            @type,
            @source,
            @modeId,
            @operationModeJson,
            @participantKind,
            @participantId,
            @title,
            @titleSource,
            @replyDelivery,
            @pendingMessagesJson,
            @pendingTranscriptGroupIdIsSet,
            @pendingTranscriptGroupId,
            @activeTranscriptGroupIdIsSet,
            @activeTranscriptGroupId,
            @historySummary,
            @historyBackfillBoundaryMs,
            @debugMarkersJson,
            @lastLlmUsageJson,
            @sentMessagesJson,
            @lastActiveAtMs,
            @lastMessageAtMs,
            @latestGapMs,
            @smoothedGapMs,
            @updatedAtMs
          )
          ON CONFLICT(session_id) DO UPDATE SET
            type = excluded.type,
            source = excluded.source,
            mode_id = excluded.mode_id,
            operation_mode_json = excluded.operation_mode_json,
            participant_kind = excluded.participant_kind,
            participant_id = excluded.participant_id,
            title = excluded.title,
            title_source = excluded.title_source,
            reply_delivery = excluded.reply_delivery,
            pending_messages_json = excluded.pending_messages_json,
            pending_transcript_group_id_is_set = excluded.pending_transcript_group_id_is_set,
            pending_transcript_group_id = excluded.pending_transcript_group_id,
            active_transcript_group_id_is_set = excluded.active_transcript_group_id_is_set,
            active_transcript_group_id = excluded.active_transcript_group_id,
            history_summary = excluded.history_summary,
            history_backfill_boundary_ms = excluded.history_backfill_boundary_ms,
            debug_markers_json = excluded.debug_markers_json,
            last_llm_usage_json = excluded.last_llm_usage_json,
            sent_messages_json = excluded.sent_messages_json,
            last_active_at_ms = excluded.last_active_at_ms,
            last_message_at_ms = excluded.last_message_at_ms,
            latest_gap_ms = excluded.latest_gap_ms,
            smoothed_gap_ms = excluded.smoothed_gap_ms,
            updated_at_ms = excluded.updated_at_ms
        `).run(toPersistedSessionParams(validated));
        syncSessionTranscriptItems(db, validated);
      });
      write();
    });
  }

  async remove(sessionId: string): Promise<void> {
    await this.enqueueWrite(sessionId, async () => {
      const db = await this.getReadyDb();
      const remove = db.transaction(() => {
        db.prepare(`DELETE FROM session_transcript_items WHERE session_id = ?`).run(sessionId);
        db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
      });
      remove();
    });
  }

  async getPersistedSessionMtimeMs(sessionId: string): Promise<number | null> {
    const db = await this.getReadyDb();
    const row = db.prepare(`
      SELECT updated_at_ms AS updatedAtMs
      FROM sessions
      WHERE session_id = ?
    `).get(sessionId) as { updatedAtMs: number } | undefined;
    return row?.updatedAtMs ?? null;
  }

  private async enqueueWrite(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        if (this.writes.get(sessionId) === next) {
          this.writes.delete(sessionId);
        }
      });
    this.writes.set(sessionId, next);
    await next;
  }

  private async getReadyDb(): Promise<SqliteDatabase> {
    if (!this.sqlite) {
      this.sqlite = await this.sqliteService.openDatabase({
        databaseId: "sessions",
        dbPath: this.dbPath,
        tableGroups: SESSION_TABLE_GROUPS,
        pragmas: {
          wal: true,
          foreignKeys: true,
          busyTimeoutMs: 5000
        },
        selfHealing: {
          resetDatabaseOnOpenFailure: false,
          resetDatabaseOnIntegrityFailure: false,
          backupInvalidDatabase: false
        }
      });
    }
    return this.sqlite.db;
  }

  async listSessionRows(input: { offset?: number; limit?: number } = {}): Promise<{
    rows: SessionRegistryRow[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const db = await this.getReadyDb();
    return listDataModelRows(db, sessionsTableModel, {
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      limit: input.limit ?? 50
    }) as unknown as {
      rows: SessionRegistryRow[];
      total: number;
      offset: number;
      limit: number;
    };
  }

  async listTranscriptRows(input: { offset?: number; limit?: number; filters?: Record<string, unknown> } = {}): Promise<{
    rows: SessionTranscriptRegistryRow[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const db = await this.getReadyDb();
    return listDataModelRows(db, sessionTranscriptItemsTableModel, {
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      limit: input.limit ?? 50,
      ...(input.filters !== undefined ? { filters: input.filters } : {})
    }) as unknown as {
      rows: SessionTranscriptRegistryRow[];
      total: number;
      offset: number;
      limit: number;
    };
  }
}

type PersistedSessionRow = {
  session_id: string;
  type: "private" | "group";
  source: "onebot" | "web" | null;
  mode_id: string | null;
  operation_mode_json: string | null;
  participant_kind: "user" | "group";
  participant_id: string;
  title: string | null;
  title_source: "default" | "auto" | "manual" | null;
  reply_delivery: "onebot" | "web" | null;
  pending_messages_json: string;
  pending_transcript_group_id_is_set: 0 | 1;
  pending_transcript_group_id: string | null;
  active_transcript_group_id_is_set: 0 | 1;
  active_transcript_group_id: string | null;
  history_summary: string | null;
  history_backfill_boundary_ms: number | null;
  internal_transcript_json: string;
  debug_markers_json: string;
  last_llm_usage_json: string | null;
  sent_messages_json: string;
  last_active_at_ms: number;
  last_message_at_ms: number | null;
  latest_gap_ms: number | null;
  smoothed_gap_ms: number | null;
};

export interface SessionRegistryRow {
  sessionId: string;
  type: "private" | "group";
  source: "onebot" | "web" | null;
  modeId: string | null;
  participantKind: "user" | "group";
  participantId: string;
  title: string | null;
  titleSource: "default" | "auto" | "manual" | null;
  replyDelivery: "onebot" | "web" | null;
  transcriptCount: number;
  lastActiveAtMs: number;
  lastMessageAtMs: number | null;
  updatedAtMs: number;
}

export interface SessionTranscriptRegistryRow {
  sessionId: string;
  itemIndex: number;
  itemId: string;
  groupId: string;
  kind: string;
  role: string | null;
  llmVisible: 0 | 1;
  runtimeExcluded: 0 | 1;
  timestampMs: number;
  itemHash: string;
  item: unknown;
}

function toPersistedSessionParams(session: PersistedSessionState): Record<string, unknown> {
  return {
    sessionId: session.id,
    type: session.type,
    source: session.source,
    modeId: session.modeId,
    operationModeJson: JSON.stringify(session.operationMode),
    participantKind: session.participantRef.kind,
    participantId: session.participantRef.id,
    title: session.title,
    titleSource: session.titleSource,
    replyDelivery: session.replyDelivery,
    pendingMessagesJson: JSON.stringify(session.pendingMessages),
    pendingTranscriptGroupIdIsSet: Number("pendingTranscriptGroupId" in session),
    pendingTranscriptGroupId: session.pendingTranscriptGroupId ?? null,
    activeTranscriptGroupIdIsSet: Number("activeTranscriptGroupId" in session),
    activeTranscriptGroupId: session.activeTranscriptGroupId ?? null,
    historySummary: session.historySummary,
    historyBackfillBoundaryMs: session.historyBackfillBoundaryMs ?? null,
    debugMarkersJson: JSON.stringify(session.debugMarkers),
    lastLlmUsageJson: session.lastLlmUsage == null ? null : JSON.stringify(session.lastLlmUsage),
    sentMessagesJson: JSON.stringify(session.sentMessages),
    lastActiveAtMs: session.lastActiveAt,
    lastMessageAtMs: session.lastMessageAt,
    latestGapMs: session.latestGapMs,
    smoothedGapMs: session.smoothedGapMs,
    updatedAtMs: Date.now()
  };
}

function syncSessionTranscriptItems(db: SqliteDatabase, session: PersistedSessionState): void {
  const existingRows = db.prepare(`
    SELECT item_id, item_index, item_hash
    FROM session_transcript_items
    WHERE session_id = ?
  `).all(session.id) as Array<{ item_id: string; item_index: number; item_hash: string }>;
  const existingById = new Map(existingRows.map((row) => [row.item_id, row]));
  const nextIds = new Set<string>();
  const updatedAtMs = Date.now();
  const nextRows = session.internalTranscript.map((item, itemIndex) => {
    const itemJson = JSON.stringify(item);
    const itemHash = hashTranscriptItem(itemJson);
    const itemId = item.id ?? `transcript:${itemIndex}:${itemHash.slice(0, 24)}`;
    const groupId = item.groupId ?? itemId;
    nextIds.add(itemId);
    return {
      sessionId: session.id,
      itemIndex,
      itemId,
      groupId,
      kind: item.kind,
      role: "role" in item ? item.role : null,
      llmVisible: item.llmVisible === false ? 0 : 1,
      runtimeExcluded: item.runtimeExcluded === true ? 1 : 0,
      timestampMs: item.timestampMs,
      itemHash,
      itemJson,
      updatedAtMs
    };
  });
  const remove = db.prepare(`
    DELETE FROM session_transcript_items
    WHERE session_id = ?
      AND item_id = ?
  `);
  for (const row of existingRows) {
    if (!nextIds.has(row.item_id)) {
      remove.run(session.id, row.item_id);
    }
  }
  const tempIndexBase = Math.max(
    session.internalTranscript.length,
    ...existingRows.map((row) => row.item_index)
  ) + 1;
  const moveAside = db.prepare(`
    UPDATE session_transcript_items
    SET item_index = ?
    WHERE session_id = ?
      AND item_id = ?
  `);
  let tempOffset = 0;
  for (const row of nextRows) {
    const existing = existingById.get(row.itemId);
    if (existing && existing.item_index !== row.itemIndex) {
      moveAside.run(tempIndexBase + tempOffset, session.id, row.itemId);
      tempOffset += 1;
    }
  }
  const upsert = db.prepare(`
    INSERT INTO session_transcript_items (
      session_id,
      item_index,
      item_id,
      group_id,
      kind,
      role,
      llm_visible,
      runtime_excluded,
      timestamp_ms,
      item_hash,
      item_json,
      updated_at_ms
    ) VALUES (
      @sessionId,
      @itemIndex,
      @itemId,
      @groupId,
      @kind,
      @role,
      @llmVisible,
      @runtimeExcluded,
      @timestampMs,
      @itemHash,
      @itemJson,
      @updatedAtMs
    )
    ON CONFLICT(session_id, item_id) DO UPDATE SET
      item_index = excluded.item_index,
      group_id = excluded.group_id,
      kind = excluded.kind,
      role = excluded.role,
      llm_visible = excluded.llm_visible,
      runtime_excluded = excluded.runtime_excluded,
      timestamp_ms = excluded.timestamp_ms,
      item_hash = excluded.item_hash,
      item_json = excluded.item_json,
      updated_at_ms = excluded.updated_at_ms
  `);
  for (const row of nextRows) {
    const existing = existingById.get(row.itemId);
    if (existing && existing.item_index === row.itemIndex && existing.item_hash === row.itemHash) {
      continue;
    }
    upsert.run(row);
  }
}

function hashTranscriptItem(itemJson: string): string {
  return createHash("sha256").update(itemJson).digest("hex");
}

function rowToPersistedSessionState(row: PersistedSessionRow): PersistedSessionState {
  return persistedSessionSchema.parse({
    id: row.session_id,
    type: row.type,
    ...(row.source ? { source: row.source } : {}),
    ...(row.mode_id ? { modeId: row.mode_id } : {}),
    ...(row.operation_mode_json ? { operationMode: JSON.parse(row.operation_mode_json) } : {}),
    participantRef: {
      kind: row.participant_kind,
      id: row.participant_id
    },
    title: row.title,
    titleSource: row.title_source,
    ...(row.reply_delivery ? { replyDelivery: row.reply_delivery } : {}),
    pendingMessages: JSON.parse(row.pending_messages_json),
    ...(row.pending_transcript_group_id_is_set === 1
      ? { pendingTranscriptGroupId: row.pending_transcript_group_id }
      : {}),
    ...(row.active_transcript_group_id_is_set === 1
      ? { activeTranscriptGroupId: row.active_transcript_group_id }
      : {}),
    historySummary: row.history_summary,
    ...(row.history_backfill_boundary_ms != null ? { historyBackfillBoundaryMs: row.history_backfill_boundary_ms } : {}),
    internalTranscript: JSON.parse(row.internal_transcript_json),
    debugMarkers: JSON.parse(row.debug_markers_json),
    lastLlmUsage: row.last_llm_usage_json == null ? null : JSON.parse(row.last_llm_usage_json),
    sentMessages: JSON.parse(row.sent_messages_json),
    lastActiveAt: row.last_active_at_ms,
    lastMessageAt: row.last_message_at_ms,
    latestGapMs: row.latest_gap_ms,
    smoothedGapMs: row.smoothed_gap_ms
  }) as PersistedSessionState;
}

const SESSION_TABLE_GROUPS = createTableGroupsFromDataDomain(sessionDataDomain);
