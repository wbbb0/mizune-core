import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import {
  assertIndexExists,
  assertTableColumns,
  SqliteService,
  type SqliteDatabase,
  type SqliteDatabaseHandle,
  type SqliteTableGroupDefinition
} from "#data/sqlite/sqliteService.ts";
import { detectScopeConflict, type ScopeConflictWarning } from "#memory/memoryCategory.ts";
import { bigramJaccardSimilarity, findBestDuplicateMatch, normalizeTitleForDedup } from "#memory/similarity.ts";
import { createUserMemoryEntry, type UserMemoryEntry } from "#memory/userMemoryEntry.ts";
import {
  buildMemoryDedupDetails,
  buildMemoryWriteDiagnostics,
  type MemoryDedupDetails,
  type MemoryWriteAction
} from "#memory/writeResult.ts";
import { contextTermOverlapScore, informativeContextTerms } from "./contextTextTerms.ts";
import type {
  ContextEmbeddingProfile,
  ContextItem,
  ContextItemPatch,
  ContextManagementItem,
  ContextMemoryFactEntry,
  ContextMemoryLayer,
  ContextMemoryProposalInput,
  ContextRawMessage,
  ContextSearchDocument,
  ContextSubjectKind
} from "./contextTypes.ts";

interface ContextItemRow {
  item_id: string;
  scope: string;
  layer: string;
  subject_kind: string;
  subject_id: string | null;
  source_type: string;
  retrieval_policy: string;
  status: string;
  user_id: string | null;
  session_id: string | null;
  toolset_id: string | null;
  mode_id: string | null;
  title: string | null;
  slot_key: string | null;
  text: string;
  embedding_text_hash: string | null;
  kind: string | null;
  source: string | null;
  confidence: number | null;
  importance: number | null;
  pinned: number;
  sensitivity: string;
  created_at: number;
  updated_at: number;
  valid_from: number | null;
  valid_to: number | null;
  superseded_by: string | null;
  last_confirmed_at: number | null;
  retrieved_count: number;
  last_retrieved_at: number | null;
  prompted_count: number;
  last_prompted_at: number | null;
  last_audited_at: number | null;
  audit_state: string | null;
}

interface ContextItemFilterInput {
  itemId?: string;
  userId?: string;
  scope?: string;
  sourceType?: string;
  status?: string;
}

export class ContextStore {
  private readonly dbPath: string;
  private sqlite: SqliteDatabaseHandle | null = null;
  private db: SqliteDatabase | null = null;
  private disabledReason: string | null = null;

  constructor(
    dataDir: string,
    private readonly config: Pick<AppConfig, "configRuntime">,
    private readonly logger: Logger,
    private readonly sqliteService = new SqliteService(logger)
  ) {
    this.dbPath = join(dataDir, "context", "context.sqlite");
  }

  async init(): Promise<void> {
    try {
      this.sqlite = await this.sqliteService.openDatabase({
        databaseId: "context",
        dbPath: this.dbPath,
        tableGroups: CONTEXT_TABLE_GROUPS,
        pragmas: {
          wal: true,
          foreignKeys: true,
          busyTimeoutMs: 5000
        },
        selfHealing: {
          resetDatabaseOnOpenFailure: true,
          resetDatabaseOnIntegrityFailure: true,
          backupInvalidDatabase: true
        }
      });
      this.db = this.sqlite.db;
      this.disabledReason = null;
      this.logger.info({
        instanceName: this.config.configRuntime.instanceName,
        dbPath: this.dbPath
      }, "context_store_initialized");
    } catch (error) {
      this.sqlite?.close();
      this.sqlite = null;
      this.db = null;
      this.disabledReason = error instanceof Error ? error.message : String(error);
      this.logger.error({
        instanceName: this.config.configRuntime.instanceName,
        dbPath: this.dbPath,
        error: this.disabledReason
      }, "context_store_disabled");
    }
  }

  close(): void {
    this.sqlite?.close();
    this.sqlite = null;
    this.db = null;
  }

  getStatus(): {
    available: boolean;
    dbPath: string;
    tableGroups?: ReturnType<SqliteDatabaseHandle["getStatus"]>["tableGroups"];
    lastDatabaseResetReason?: string;
    disabledReason?: string;
  } {
    const sqliteStatus = this.sqlite?.getStatus();
    return {
      available: this.db != null,
      dbPath: this.dbPath,
      ...(sqliteStatus?.tableGroups ? { tableGroups: sqliteStatus.tableGroups } : {}),
      ...(sqliteStatus?.lastDatabaseResetReason ? { lastDatabaseResetReason: sqliteStatus.lastDatabaseResetReason } : {}),
      ...(this.disabledReason ? { disabledReason: this.disabledReason } : {})
    };
  }

  listUserFacts(userId: string): ContextMemoryFactEntry[] {
    if (!this.db) {
      return [];
    }
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT *
      FROM context_items
      WHERE scope = 'user'
        AND source_type = 'fact'
        AND status = 'active'
        AND user_id = ?
        AND sensitivity != 'secret'
        AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY updated_at DESC
    `).all(userId, now) as ContextItemRow[];
    return rows.map(rowToContextMemoryFactEntry);
  }

  listUserPromptFacts(userId: string): ContextMemoryFactEntry[] {
    if (!this.db) {
      return [];
    }
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT *
      FROM context_items
      WHERE scope = 'user'
        AND source_type = 'fact'
        AND status = 'active'
        AND user_id = ?
        AND retrieval_policy = 'always'
        AND layer IN ('profile_slot', 'core_fact')
        AND sensitivity != 'secret'
        AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY updated_at DESC
    `).all(userId, now) as ContextItemRow[];
    return rows.map(rowToContextMemoryFactEntry);
  }

  upsertUserFact(input: {
    userId: string;
    memoryId?: string;
    slotKey?: string;
    supersedeMemoryIds?: string[];
    writeMode?: "update_existing" | "supersede_existing";
    title: string;
    content: string;
    kind?: UserMemoryEntry["kind"];
    source?: UserMemoryEntry["source"];
    importance?: number;
  }): {
    item: UserMemoryEntry;
    action: MemoryWriteAction;
    finalAction: "created" | "updated_existing" | "warning_scope_conflict";
    dedup: MemoryDedupDetails;
    warning: ScopeConflictWarning | null;
  } {
    this.requireDb();
    const existingFacts = this.listUserFacts(input.userId);
    const explicitTarget = input.memoryId
      ? existingFacts.find((item) => item.id === input.memoryId) ?? null
      : null;
    if (input.memoryId && !explicitTarget) {
      throw new Error(`Memory ${input.memoryId} not found for user ${input.userId}`);
    }
    const slotKey = normalizeContextSlotKeyOrThrow(input.slotKey);
    const slotMatches = !slotKey
      ? []
      : findSameSlotKeyFacts(slotKey, existingFacts);
    const slotMatch = slotMatches[0] ?? null;
    const supersedeTargets = input.writeMode === "supersede_existing"
      ? collectSupersedeTargets(existingFacts, [
          ...(explicitTarget ? [explicitTarget.id] : []),
          ...slotMatches.map((item) => item.id),
          ...(input.supersedeMemoryIds ?? [])
        ])
      : [];
    const shouldSupersede = supersedeTargets.length > 0;
    const exactTitleMatch = input.memoryId || shouldSupersede
      ? null
      : findSameSlotUserFact(input.title, existingFacts);
    const duplicate = input.memoryId || slotMatch || exactTitleMatch
      ? null
      : findBestDuplicateMatch(
          `${normalizeTitleForDedup(input.title)} ${input.content}`,
          existingFacts,
            (item) => `${normalizeTitleForDedup(item.title)} ${item.content}`
        );
    const targetId = shouldSupersede
      ? undefined
      : input.memoryId || slotMatch?.id || exactTitleMatch?.id || duplicate?.item.id;
    const existingTarget = targetId
      ? existingFacts.find((item) => item.id === targetId) ?? null
      : null;
    const matchedExisting = existingTarget != null;
    const action = matchedExisting ? "updated_existing" as const : "created" as const;
    const nextMemory = createUserMemoryEntry({
      ...(targetId ? { id: targetId } : {}),
      ...(existingTarget ? { createdAt: existingTarget.createdAt } : {}),
      title: input.title,
      content: input.content,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {})
    });
    const layer = resolveUserFactLayer({
      slotKey,
      kind: nextMemory.kind,
      importance: nextMemory.importance,
      pinned: false,
      sourceType: "fact"
    });
    this.upsertContextItem({
      itemId: nextMemory.id,
      scope: "user",
      sourceType: "fact",
      layer,
      retrievalPolicy: retrievalPolicyForLayer(layer),
      status: "active",
      userId: input.userId,
      title: nextMemory.title,
      ...(slotKey !== undefined ? { slotKey } : existingTarget?.slotKey ? { slotKey: existingTarget.slotKey } : {}),
      text: nextMemory.content,
      ...(nextMemory.kind !== undefined ? { kind: nextMemory.kind } : {}),
      ...(nextMemory.source !== undefined ? { source: nextMemory.source } : {}),
      ...(nextMemory.importance !== undefined ? { importance: nextMemory.importance } : {}),
      sensitivity: "normal",
      createdAt: nextMemory.createdAt,
      updatedAt: nextMemory.updatedAt,
      retrievedCount: 0,
      ...(nextMemory.lastUsedAt !== undefined ? { lastRetrievedAt: nextMemory.lastUsedAt } : {})
    });
    for (const staleSlotMatch of shouldSupersede ? supersedeTargets : slotMatches) {
      if (staleSlotMatch.id === nextMemory.id) {
        continue;
      }
      this.updateContextItem({
        itemId: staleSlotMatch.id,
        status: "superseded",
        supersededBy: nextMemory.id,
        validTo: nextMemory.updatedAt
      });
    }
    const dedup = buildMemoryDedupDetails({
      explicitId: input.memoryId ?? null,
      duplicateId: supersedeTargets[0]?.id ?? slotMatch?.id ?? exactTitleMatch?.id ?? duplicate?.item.id ?? null,
      similarityScore: exactTitleMatch ? 1 : duplicate?.similarityScore ?? null,
      matchedExisting
    });
    const warning = detectScopeConflict({
      currentScope: "user_memories",
      title: input.title,
      content: input.content
    });
    const diagnostics = buildMemoryWriteDiagnostics({
      targetCategory: "user_memories",
      action,
      dedup,
      warning
    });
    this.logger.info({
      targetCategory: diagnostics.targetCategory,
      userId: input.userId,
      memoryId: nextMemory.id,
      action: diagnostics.action,
      finalAction: diagnostics.finalAction,
      dedupMatchedBy: diagnostics.dedup.matchedBy,
      dedupMatchedExistingId: diagnostics.dedup.matchedExistingId,
      dedupSimilarityScore: diagnostics.dedup.similarityScore,
      rerouteResult: diagnostics.reroute.result,
      rerouteSuggestedScope: diagnostics.reroute.suggestedScope,
      rerouteReason: diagnostics.reroute.reason
    }, "user_memory_upserted");
    if (warning) {
      this.logger.warn({
        targetCategory: "user_memories",
        userId: input.userId,
        memoryId: nextMemory.id,
        suggestedScope: warning.suggestedScope,
        reason: warning.reason
      }, "memory_scope_conflict_detected");
    }
    return {
      item: nextMemory,
      action,
      finalAction: diagnostics.finalAction,
      dedup,
      warning
    };
  }

  upsertMemoryProposal(input: ContextMemoryProposalInput): ContextManagementItem {
    const now = input.createdAt ?? Date.now();
    const scope = normalizeContextScope(input.scope);
    const subject = resolveContextSubject({
      scope,
      userId: input.userId,
      sessionId: input.sessionId,
      toolsetId: input.toolsetId,
      modeId: input.modeId
    });
    assertConcreteSubject(scope, subject);
    const title = input.title.trim().slice(0, 80);
    const content = input.content.trim().slice(0, 800);
    if (!title || !content) {
      throw new Error("memory proposal title and content cannot be empty");
    }
    const itemId = buildMemoryProposalId({
      scope,
      subjectKind: subject.subjectKind,
      ...(subject.subjectId ? { subjectId: subject.subjectId } : {}),
      title,
      content
    });
    const existing = this.getContextItem(itemId);
    this.upsertContextItem({
      itemId,
      scope,
      layer: "proposal",
      subjectKind: subject.subjectKind,
      ...(subject.subjectId ? { subjectId: subject.subjectId } : {}),
      sourceType: "fact",
      retrievalPolicy: "never",
      status: "pending",
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.toolsetId ? { toolsetId: input.toolsetId } : {}),
      ...(input.modeId ? { modeId: input.modeId } : {}),
      title,
      text: content,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      sensitivity: "normal",
      createdAt: now,
      updatedAt: now,
      retrievedCount: 0
    });
    for (const sourceRef of input.sourceRefs ?? []) {
      this.addContextItemSource({
        itemId,
        sourceKind: sourceRef.sourceKind,
        sourceId: sourceRef.sourceId,
        createdAt: now
      });
    }
    if (!existing) {
      this.addManualAuditEvent({
        eventType: "memory_proposal_created",
        itemId,
        payload: {
          reason: input.reason,
          scope,
          subjectKind: subject.subjectKind,
          subjectId: subject.subjectId ?? null,
          confidence: input.confidence ?? null
        },
        createdAt: now
      });
    }
    const item = this.getContextItem(itemId);
    if (!item) {
      throw new Error(`Memory proposal ${itemId} was not stored`);
    }
    this.logger.info({
      itemId,
      scope,
      subjectKind: subject.subjectKind,
      subjectId: subject.subjectId,
      reason: input.reason
    }, "context_memory_proposal_upserted");
    return item;
  }

  listSessionFacts(sessionId: string): ContextMemoryFactEntry[] {
    if (!this.db) {
      return [];
    }
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT *
      FROM context_items
      WHERE scope = 'session'
        AND source_type = 'fact'
        AND status = 'active'
        AND session_id = ?
        AND sensitivity != 'secret'
        AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY updated_at DESC
    `).all(sessionId, now) as ContextItemRow[];
    return rows.map(rowToContextMemoryFactEntry);
  }

  upsertSessionFact(input: {
    sessionId: string;
    memoryId?: string;
    slotKey?: string;
    supersedeMemoryIds?: string[];
    writeMode?: "update_existing" | "supersede_existing";
    title: string;
    content: string;
    kind?: UserMemoryEntry["kind"];
    source?: UserMemoryEntry["source"];
    importance?: number;
    validTo?: number;
    lastConfirmedAt?: number;
  }): {
    item: UserMemoryEntry;
    action: "created" | "updated_existing";
  } {
    this.requireDb();
    const existingFacts = this.listSessionFacts(input.sessionId);
    const explicitTarget = input.memoryId
      ? existingFacts.find((item) => item.id === input.memoryId) ?? null
      : null;
    if (input.memoryId && !explicitTarget) {
      throw new Error(`Session memory ${input.memoryId} not found for session ${input.sessionId}`);
    }
    const slotKey = normalizeContextSlotKeyOrThrow(input.slotKey);
    const slotMatches = !slotKey
      ? []
      : findSameSlotKeyFacts(slotKey, existingFacts);
    const slotMatch = slotMatches[0] ?? null;
    const supersedeTargets = input.writeMode === "supersede_existing"
      ? collectSupersedeTargets(existingFacts, [
          ...(explicitTarget ? [explicitTarget.id] : []),
          ...slotMatches.map((item) => item.id),
          ...(input.supersedeMemoryIds ?? [])
        ])
      : [];
    const shouldSupersede = supersedeTargets.length > 0;
    const exactTitleMatch = input.memoryId || shouldSupersede
      ? null
      : findSameSlotUserFact(input.title, existingFacts);
    const targetId = shouldSupersede
      ? undefined
      : input.memoryId || slotMatch?.id || exactTitleMatch?.id;
    const existingTarget = targetId
      ? existingFacts.find((item) => item.id === targetId) ?? null
      : null;
    const nextMemory = createUserMemoryEntry({
      ...(targetId ? { id: targetId } : {}),
      ...(existingTarget ? { createdAt: existingTarget.createdAt } : {}),
      title: input.title,
      content: input.content,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {})
    });
    const layer = resolveSessionFactLayer({
      slotKey,
      kind: nextMemory.kind,
      importance: nextMemory.importance,
      pinned: false,
      sourceType: "fact"
    });
    this.upsertContextItem({
      itemId: nextMemory.id,
      scope: "session",
      sourceType: "fact",
      layer,
      retrievalPolicy: "always",
      status: "active",
      sessionId: input.sessionId,
      title: nextMemory.title,
      ...(slotKey !== undefined ? { slotKey } : existingTarget?.slotKey ? { slotKey: existingTarget.slotKey } : {}),
      text: nextMemory.content,
      ...(nextMemory.kind !== undefined ? { kind: nextMemory.kind } : {}),
      ...(nextMemory.source !== undefined ? { source: nextMemory.source } : {}),
      ...(nextMemory.importance !== undefined ? { importance: nextMemory.importance } : {}),
      sensitivity: "normal",
      createdAt: nextMemory.createdAt,
      updatedAt: nextMemory.updatedAt,
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
      ...(input.lastConfirmedAt !== undefined ? { lastConfirmedAt: input.lastConfirmedAt } : {}),
      retrievedCount: 0,
      ...(nextMemory.lastUsedAt !== undefined ? { lastRetrievedAt: nextMemory.lastUsedAt } : {})
    });
    for (const staleSlotMatch of shouldSupersede ? supersedeTargets : slotMatches) {
      if (staleSlotMatch.id === nextMemory.id) {
        continue;
      }
      this.updateContextItem({
        itemId: staleSlotMatch.id,
        status: "superseded",
        supersededBy: nextMemory.id,
        validTo: nextMemory.updatedAt
      });
    }
    const action = existingTarget ? "updated_existing" as const : "created" as const;
    this.logger.info({
      sessionId: input.sessionId,
      memoryId: nextMemory.id,
      action
    }, "session_memory_upserted");
    return {
      item: nextMemory,
      action
    };
  }

  removeUserFact(userId: string, memoryId: string): {
    removed: boolean;
    suppressedSearchCount: number;
    remaining: UserMemoryEntry[];
  } {
    const db = this.requireDb();
    const now = Date.now();
    const remove = db.transaction(() => {
      const fact = db.prepare(`
        SELECT *
        FROM context_items
        WHERE item_id = @itemId
          AND scope = 'user'
          AND source_type = 'fact'
          AND user_id = @userId
          AND status != 'deleted'
      `).get({
        itemId: memoryId,
        userId
      }) as ContextItemRow | undefined;
      if (!fact) {
        return { removed: false, suppressedSearchCount: 0 };
      }
      const result = db.prepare(`
        UPDATE context_items
        SET status = 'deleted', updated_at = @updatedAt
        WHERE item_id = @itemId
          AND scope = 'user'
          AND source_type = 'fact'
          AND user_id = @userId
          AND status != 'deleted'
      `).run({
        itemId: memoryId,
        userId,
        updatedAt: now
      });
      const searchRows = db.prepare(`
        SELECT *
        FROM context_items
        WHERE scope = 'user'
          AND source_type IN ('chunk', 'summary')
          AND retrieval_policy = 'search'
          AND status = 'active'
          AND user_id = @userId
      `).all({ userId }) as ContextItemRow[];
      const relatedIds = searchRows
        .filter((row) => isRelatedToRemovedFact(row, fact))
        .map((row) => row.item_id);
      if (relatedIds.length > 0) {
        db.prepare(`
          UPDATE context_items
          SET status = 'superseded',
              superseded_by = ?,
              valid_to = ?,
              updated_at = ?
          WHERE item_id IN (${relatedIds.map(() => "?").join(",")})
        `).run(memoryId, now, now, ...relatedIds);
      }
      return {
        removed: result.changes > 0,
        suppressedSearchCount: relatedIds.length
      };
    });
    const result = remove() as { removed: boolean; suppressedSearchCount: number };
    if (result.removed) {
      this.logger.info({ userId, memoryId, suppressedSearchCount: result.suppressedSearchCount }, "user_memory_removed");
    }
    return {
      removed: result.removed,
      suppressedSearchCount: result.suppressedSearchCount,
      remaining: this.listUserFacts(userId)
    };
  }

  findUserFactsByText(input: {
    userId: string;
    query: string;
    limit?: number;
  }): Array<{
    item: UserMemoryEntry;
    score: number;
  }> {
    const query = input.query.trim();
    if (!query) {
      return [];
    }
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
    return this.listUserFacts(input.userId)
      .map((item) => ({
        item,
        score: scoreUserFactTextMatch(query, item)
      }))
      .filter((match) => match.score >= USER_FACT_TEXT_MATCH_MIN_SCORE)
      .sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt)
      .slice(0, limit);
  }

  removeUserFactByText(userId: string, query: string): {
    removed: boolean;
    reason?: "not_found" | "ambiguous";
    match?: UserMemoryEntry;
    candidates: Array<{ item: UserMemoryEntry; score: number }>;
    suppressedSearchCount: number;
    remaining: UserMemoryEntry[];
  } {
    const candidates = this.findUserFactsByText({ userId, query });
    const unique = resolveUniqueUserFactTextMatch(candidates);
    if (!unique) {
      return {
        removed: false,
        reason: candidates.length === 0 ? "not_found" : "ambiguous",
        candidates,
        suppressedSearchCount: 0,
        remaining: this.listUserFacts(userId)
      };
    }
    const removed = this.removeUserFact(userId, unique.item.id);
    return {
      removed: removed.removed,
      match: unique.item,
      candidates,
      suppressedSearchCount: removed.suppressedSearchCount,
      remaining: removed.remaining
    };
  }

  replaceUserFactByText(input: {
    userId: string;
    query: string;
    title: string;
    content: string;
    kind?: UserMemoryEntry["kind"];
    source?: UserMemoryEntry["source"];
    importance?: number;
  }): {
    replaced: boolean;
    reason?: "not_found" | "ambiguous";
    match?: UserMemoryEntry;
    candidates: Array<{ item: UserMemoryEntry; score: number }>;
    result?: ReturnType<ContextStore["upsertUserFact"]>;
    remaining: UserMemoryEntry[];
  } {
    const candidates = this.findUserFactsByText({ userId: input.userId, query: input.query });
    const unique = resolveUniqueUserFactTextMatch(candidates);
    if (!unique) {
      return {
        replaced: false,
        reason: candidates.length === 0 ? "not_found" : "ambiguous",
        candidates,
        remaining: this.listUserFacts(input.userId)
      };
    }
    const result = this.upsertUserFact({
      userId: input.userId,
      memoryId: unique.item.id,
      title: input.title,
      content: input.content,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {})
    });
    return {
      replaced: true,
      match: unique.item,
      candidates,
      result,
      remaining: this.listUserFacts(input.userId)
    };
  }

  listContextItems(input: {
    userId?: string;
    scope?: string;
    sourceType?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): {
    items: ContextManagementItem[];
    total: number;
  } {
    if (!this.db) {
      return { items: [], total: 0 };
    }
    const { whereSql, params } = buildContextItemWhere(input);
    const total = (this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM context_items
      ${whereSql}
    `).get(...params) as { count: number }).count;
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    const rows = this.db.prepare(`
      SELECT *
      FROM context_items
      ${whereSql}
      ORDER BY updated_at DESC, created_at DESC, item_id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as ContextItemRow[];
    return {
      items: rows.map(rowToContextManagementItem),
      total
    };
  }

  listRawMessages(input: {
    offset?: number;
    limit?: number;
  } = {}): {
    rows: unknown[];
    total: number;
    offset: number;
    limit: number;
  } {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    if (!this.db) {
      return { rows: [], total: 0, offset, limit };
    }
    const total = (this.db.prepare("SELECT COUNT(*) AS count FROM raw_messages").get() as { count: number }).count;
    const rows = this.db.prepare(`
      SELECT message_id, user_id, session_id, chat_type, role, speaker_id,
             timestamp_ms, text, segments_json, attachment_refs_json,
             sensitivity, ingested_at
      FROM raw_messages
      ORDER BY timestamp_ms DESC, ingested_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as unknown[];
    return { rows, total, offset, limit };
  }

  listMaintenanceJobs(input: {
    offset?: number;
    limit?: number;
  } = {}): {
    rows: unknown[];
    total: number;
    offset: number;
    limit: number;
  } {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    if (!this.db) {
      return { rows: [], total: 0, offset, limit };
    }
    const total = (this.db.prepare("SELECT COUNT(*) AS count FROM maintenance_jobs").get() as { count: number }).count;
    const rows = this.db.prepare(`
      SELECT job_id, job_type, status, payload_json, scheduled_at, started_at, finished_at, error
      FROM maintenance_jobs
      ORDER BY scheduled_at DESC, job_id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as unknown[];
    return { rows, total, offset, limit };
  }

  listContextItemSources(input: {
    offset?: number;
    limit?: number;
    filters?: Record<string, unknown>;
  } = {}): {
    rows: unknown[];
    total: number;
    offset: number;
    limit: number;
  } {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    if (!this.db) {
      return { rows: [], total: 0, offset, limit };
    }
    const itemId = typeof input.filters?.itemId === "string" && input.filters.itemId.trim()
      ? input.filters.itemId.trim()
      : null;
    const whereSql = itemId ? "WHERE item_id = ?" : "";
    const params = itemId ? [itemId] : [];
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM context_item_sources ${whereSql}`).get(...params) as { count: number }).count;
    const rows = this.db.prepare(`
      SELECT
        item_id AS itemId,
        source_kind AS sourceKind,
        source_id AS sourceId,
        created_at AS createdAt
      FROM context_item_sources
      ${whereSql}
      ORDER BY item_id ASC, created_at ASC, source_kind ASC, source_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as unknown[];
    return { rows, total, offset, limit };
  }

  listContextItemEmbeddings(input: {
    offset?: number;
    limit?: number;
    filters?: Record<string, unknown>;
  } = {}): {
    rows: unknown[];
    total: number;
    offset: number;
    limit: number;
  } {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    if (!this.db) {
      return { rows: [], total: 0, offset, limit };
    }
    const itemId = typeof input.filters?.itemId === "string" && input.filters.itemId.trim()
      ? input.filters.itemId.trim()
      : null;
    const whereSql = itemId ? "WHERE item_id = ?" : "";
    const params = itemId ? [itemId] : [];
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM context_item_embeddings ${whereSql}`).get(...params) as { count: number }).count;
    const rows = this.db.prepare(`
      SELECT
        item_id AS itemId,
        embedding_profile_id AS embeddingProfileId,
        text_hash AS textHash,
        dimension,
        length(vector) AS vectorBytes,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM context_item_embeddings
      ${whereSql}
      ORDER BY item_id ASC, embedding_profile_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as unknown[];
    return { rows, total, offset, limit };
  }

  listEmbeddingProfiles(input: {
    offset?: number;
    limit?: number;
  } = {}): {
    rows: unknown[];
    total: number;
    offset: number;
    limit: number;
  } {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    if (!this.db) {
      return { rows: [], total: 0, offset, limit };
    }
    const total = (this.db.prepare("SELECT COUNT(*) AS count FROM embedding_profiles").get() as { count: number }).count;
    const rows = this.db.prepare(`
      SELECT
        profile_id AS profileId,
        instance_name AS instanceName,
        provider,
        model,
        dimension,
        distance,
        text_preprocess_version AS textPreprocessVersion,
        chunker_version AS chunkerVersion,
        active,
        created_at AS createdAt
      FROM embedding_profiles
      ORDER BY active DESC, created_at DESC, profile_id ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as Array<Record<string, unknown> & { active: 0 | 1 }>;
    return {
      rows: rows.map((row) => ({ ...row, active: row.active === 1 })),
      total,
      offset,
      limit
    };
  }

  listManualAuditEvents(input: {
    offset?: number;
    limit?: number;
    filters?: Record<string, unknown>;
  } = {}): {
    rows: unknown[];
    total: number;
    offset: number;
    limit: number;
  } {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    if (!this.db) {
      return { rows: [], total: 0, offset, limit };
    }
    const itemId = typeof input.filters?.itemId === "string" && input.filters.itemId.trim()
      ? input.filters.itemId.trim()
      : null;
    const whereSql = itemId ? "WHERE item_id = ?" : "";
    const params = itemId ? [itemId] : [];
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM manual_audit_events ${whereSql}`).get(...params) as { count: number }).count;
    const rows = this.db.prepare(`
      SELECT
        event_id AS eventId,
        event_type AS eventType,
        actor_id AS actorId,
        item_id AS itemId,
        payload_json AS payloadJson,
        created_at AS createdAt
      FROM manual_audit_events
      ${whereSql}
      ORDER BY created_at DESC, event_id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as unknown[];
    return { rows, total, offset, limit };
  }

  getContextStats(): {
    rawMessages: number;
    contextItems: number;
    embeddings: number;
    byScope: Array<{ scope: string; count: number }>;
    bySourceType: Array<{ sourceType: string; count: number }>;
    byStatus: Array<{ status: string; count: number }>;
    sqlitePageCount: number;
    sqlitePageSize: number;
    sqliteBytes: number;
  } {
    if (!this.db) {
      return {
        rawMessages: 0,
        contextItems: 0,
        embeddings: 0,
        byScope: [],
        bySourceType: [],
        byStatus: [],
        sqlitePageCount: 0,
        sqlitePageSize: 0,
        sqliteBytes: 0
      };
    }
    const rawMessages = getCount(this.db, "raw_messages");
    const contextItems = getCount(this.db, "context_items");
    const embeddings = getCount(this.db, "context_item_embeddings");
    const sqlitePageCount = Number(this.db.pragma("page_count", { simple: true }) ?? 0);
    const sqlitePageSize = Number(this.db.pragma("page_size", { simple: true }) ?? 0);
    return {
      rawMessages,
      contextItems,
      embeddings,
      byScope: this.db.prepare(`
        SELECT scope, COUNT(*) AS count
        FROM context_items
        GROUP BY scope
        ORDER BY scope
      `).all() as Array<{ scope: string; count: number }>,
      bySourceType: (this.db.prepare(`
        SELECT source_type AS sourceType, COUNT(*) AS count
        FROM context_items
        GROUP BY source_type
        ORDER BY source_type
      `).all() as Array<{ sourceType: string; count: number }>),
      byStatus: this.db.prepare(`
        SELECT status, COUNT(*) AS count
        FROM context_items
        GROUP BY status
        ORDER BY status
      `).all() as Array<{ status: string; count: number }>,
      sqlitePageCount,
      sqlitePageSize,
      sqliteBytes: sqlitePageCount * sqlitePageSize
    };
  }

  listUserIdsWithSearchChunks(): string[] {
    if (!this.db) {
      return [];
    }
    const rows = this.db.prepare(`
      SELECT DISTINCT user_id
      FROM context_items
      WHERE scope = 'user'
        AND source_type = 'chunk'
        AND retrieval_policy = 'search'
        AND status = 'active'
        AND user_id IS NOT NULL
      ORDER BY user_id ASC
    `).all() as Array<{ user_id: string }>;
    return rows.map((row) => row.user_id);
  }

  listUserIdsWithSearchDocuments(): string[] {
    if (!this.db) {
      return [];
    }
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT DISTINCT user_id
      FROM context_items
      WHERE scope = 'user'
        AND retrieval_policy = 'search'
        AND status = 'active'
        AND sensitivity != 'secret'
        AND user_id IS NOT NULL
        AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY user_id ASC
    `).all(now) as Array<{ user_id: string }>;
    return rows.map((row) => row.user_id);
  }

  deleteContextItem(itemId: string): {
    deleted: boolean;
  } {
    if (!this.db) {
      return { deleted: false };
    }
    const result = this.db.prepare(`
      UPDATE context_items
      SET status = 'deleted', updated_at = ?
      WHERE item_id = ?
        AND status != 'deleted'
    `).run(Date.now(), itemId);
    if (result.changes > 0) {
      this.logger.info({ itemId }, "context_item_deleted");
    }
    return { deleted: result.changes > 0 };
  }

  setContextItemPinned(itemId: string, pinned: boolean): {
    updated: boolean;
  } {
    if (!this.db) {
      return { updated: false };
    }
    const result = this.db.prepare(`
      UPDATE context_items
      SET pinned = ?, updated_at = ?
      WHERE item_id = ?
    `).run(pinned ? 1 : 0, Date.now(), itemId);
    if (result.changes > 0) {
      this.recalculateDerivedContextItemFields(itemId);
      this.logger.info({ itemId, pinned }, "context_item_pin_updated");
    }
    return { updated: result.changes > 0 };
  }

  updateContextItem(input: ContextItemPatch): {
    updated: boolean;
    item: ContextManagementItem | null;
  } {
    if (!this.db) {
      return { updated: false, item: null };
    }
    const fields: string[] = [];
    const params: Record<string, string | number | null> = {
      itemId: input.itemId,
      updatedAt: Date.now()
    };
    if ("title" in input) {
      fields.push("title = @title");
      params.title = input.title?.trim() || null;
    }
    if ("slotKey" in input) {
      fields.push("slot_key = @slotKey");
      params.slotKey = normalizeContextSlotKeyOrThrow(input.slotKey) ?? null;
    }
    if (input.text !== undefined) {
      const text = input.text.trim();
      if (!text) {
        throw new Error("context item text cannot be empty");
      }
      fields.push("text = @text");
      params.text = text;
      fields.push("embedding_text_hash = @embeddingTextHash");
      params.embeddingTextHash = buildContextEmbeddingTextHash(text);
    }
    if (input.retrievalPolicy !== undefined) {
      fields.push("retrieval_policy = @retrievalPolicy");
      params.retrievalPolicy = input.retrievalPolicy;
    }
    if (input.status !== undefined) {
      fields.push("status = @status");
      params.status = input.status;
    }
    if (input.sensitivity !== undefined) {
      fields.push("sensitivity = @sensitivity");
      params.sensitivity = input.sensitivity;
    }
    if ("importance" in input) {
      fields.push("importance = @importance");
      params.importance = input.importance ?? null;
    }
    if (input.pinned !== undefined) {
      fields.push("pinned = @pinned");
      params.pinned = input.pinned ? 1 : 0;
    }
    if ("validTo" in input) {
      fields.push("valid_to = @validTo");
      params.validTo = input.validTo ?? null;
    }
    if ("supersededBy" in input) {
      fields.push("superseded_by = @supersededBy");
      params.supersededBy = input.supersededBy ?? null;
      if (input.supersededBy && input.status === undefined) {
        fields.push("status = 'superseded'");
      }
    }
    if ((input.status === "superseded" || input.supersededBy) && !("validTo" in input)) {
      fields.push("valid_to = @validTo");
      params.validTo = Number(params.updatedAt);
    }
    if (fields.length === 0) {
      return {
        updated: false,
        item: this.getContextItem(input.itemId)
      };
    }
    fields.push("updated_at = @updatedAt");
    const result = this.db.prepare(`
      UPDATE context_items
      SET ${fields.join(", ")}
      WHERE item_id = @itemId
    `).run(params);
    if (result.changes > 0) {
      this.recalculateDerivedContextItemFields(input.itemId);
      if ("title" in input || input.text !== undefined) {
        this.clearEmbeddings({ itemId: input.itemId });
      }
      this.logger.info({ itemId: input.itemId }, "context_item_updated");
    }
    return {
      updated: result.changes > 0,
      item: this.getContextItem(input.itemId)
    };
  }

  bulkDeleteContextItems(input: ContextItemFilterInput): {
    deletedCount: number;
  } {
    if (!this.db) {
      return { deletedCount: 0 };
    }
    const { whereSql, params } = buildContextItemWhere(input, ["status != 'deleted'"]);
    const result = this.db.prepare(`
      UPDATE context_items
      SET status = 'deleted', updated_at = ?
      ${whereSql}
    `).run(Date.now(), ...params);
    if (result.changes > 0) {
      this.logger.info({ filters: input, deletedCount: result.changes }, "context_items_bulk_deleted");
    }
    return { deletedCount: result.changes };
  }

  deleteSessionScopedItems(sessionId: string): {
    deletedCount: number;
  } {
    if (!this.db) {
      return { deletedCount: 0 };
    }
    const result = this.db.prepare(`
      UPDATE context_items
      SET status = 'deleted', updated_at = ?
      WHERE scope = 'session'
        AND session_id = ?
        AND status != 'deleted'
    `).run(Date.now(), sessionId);
    if (result.changes > 0) {
      this.logger.info({ sessionId, deletedCount: result.changes }, "context_session_scoped_items_deleted");
    }
    return { deletedCount: result.changes };
  }

  exportContextItemsJsonl(input: ContextItemFilterInput = {}): {
    count: number;
    jsonl: string;
  } {
    if (!this.db) {
      return { count: 0, jsonl: "" };
    }
    const { whereSql, params } = buildContextItemWhere(input);
    const rows = this.db.prepare(`
      SELECT *
      FROM context_items
      ${whereSql}
      ORDER BY updated_at DESC, created_at DESC, item_id ASC
    `).all(...params) as ContextItemRow[];
    return {
      count: rows.length,
      jsonl: rows.map((row) => JSON.stringify(rowToContextItem(row))).join("\n")
    };
  }

  importContextItemsJsonl(jsonl: string): {
    importedCount: number;
    skippedCount: number;
  } {
    if (!this.db) {
      return { importedCount: 0, skippedCount: 0 };
    }
    let importedCount = 0;
    let skippedCount = 0;
    const importItems = this.db.transaction(() => {
      for (const line of jsonl.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const item = parseContextItemImportLine(trimmed);
        if (!item) {
          skippedCount += 1;
          continue;
        }
        this.upsertContextItem(item);
        importedCount += 1;
      }
    });
    importItems();
    if (importedCount > 0 || skippedCount > 0) {
      this.logger.info({ importedCount, skippedCount }, "context_items_imported");
    }
    return { importedCount, skippedCount };
  }

  sweepDeletedItems(input: {
    deletedBeforeMs: number;
    now?: number;
  }): {
    deletedCount: number;
  } {
    if (!this.db) {
      return { deletedCount: 0 };
    }
    const cutoff = (input.now ?? Date.now()) - input.deletedBeforeMs;
    const result = this.db.prepare(`
      DELETE FROM context_items
      WHERE status = 'deleted'
        AND updated_at < ?
    `).run(cutoff);
    if (result.changes > 0) {
      this.logger.info({ deletedCount: result.changes, deletedBeforeMs: input.deletedBeforeMs }, "context_deleted_items_swept");
    }
    return { deletedCount: result.changes };
  }

  sweepExpiredSessionFacts(input: {
    now?: number;
  } = {}): {
    deletedCount: number;
  } {
    if (!this.db) {
      return { deletedCount: 0 };
    }
    const now = input.now ?? Date.now();
    const result = this.db.prepare(`
      DELETE FROM context_items
      WHERE scope = 'session'
        AND source_type = 'fact'
        AND status = 'active'
        AND pinned = 0
        AND valid_to IS NOT NULL
        AND valid_to <= ?
    `).run(now);
    if (result.changes > 0) {
      this.logger.info({ deletedCount: result.changes }, "context_expired_session_facts_swept");
    }
    return { deletedCount: result.changes };
  }

  clearEmbeddings(input: ContextItemFilterInput = {}): {
    deletedCount: number;
  } {
    if (!this.db) {
      return { deletedCount: 0 };
    }
    const { whereSql, params } = buildContextItemWhere(input);
    const result = this.db.prepare(`
      DELETE FROM context_item_embeddings
      WHERE item_id IN (
        SELECT item_id
        FROM context_items
        ${whereSql}
      )
    `).run(...params);
    if (result.changes > 0) {
      this.logger.info({ filters: input, deletedCount: result.changes }, "context_embeddings_cleared");
    }
    return { deletedCount: result.changes };
  }

  compactUserSearchChunks(input: {
    userId: string;
    olderThanMs: number;
    maxSourceChunks?: number;
    now?: number;
  }): {
    compactedCount: number;
    summaryItemId?: string;
  } {
    if (!this.db) {
      return { compactedCount: 0 };
    }
    const now = input.now ?? Date.now();
    const cutoff = now - input.olderThanMs;
    const maxSourceChunks = Math.min(Math.max(input.maxSourceChunks ?? 20, 1), 100);
    const compact = this.db.transaction(() => {
      const rows = this.db!.prepare(`
        SELECT *
        FROM context_items
        WHERE scope = 'user'
          AND source_type = 'chunk'
          AND retrieval_policy = 'search'
          AND status = 'active'
          AND pinned = 0
          AND user_id = ?
          AND updated_at < ?
        ORDER BY updated_at ASC, created_at ASC, item_id ASC
        LIMIT ?
      `).all(input.userId, cutoff, maxSourceChunks) as ContextItemRow[];
      if (rows.length === 0) {
        return { compactedCount: 0 };
      }
      const first = rows[0]!;
      const last = rows[rows.length - 1]!;
      const summaryItemId = `ctx_summary_${input.userId}_${first.updated_at}_${last.updated_at}`;
      const summaryText = rows
        .map((row) => `- ${row.title ? `${row.title}：` : ""}${row.text}`)
        .join("\n");
      this.upsertContextItem({
        itemId: summaryItemId,
        scope: "user",
        sourceType: "summary",
        retrievalPolicy: "search",
        status: "active",
        userId: input.userId,
        title: `历史摘要 ${new Date(first.updated_at).toLocaleString("zh-CN")} - ${new Date(last.updated_at).toLocaleString("zh-CN")}`,
        text: summaryText,
        source: "system",
        importance: Math.max(...rows.map((row) => row.importance ?? 0), 0),
        sensitivity: "normal",
        createdAt: now,
        updatedAt: now,
        retrievedCount: 0
      });
      const archive = this.db!.prepare(`
        UPDATE context_items
        SET status = 'archived', updated_at = ?
        WHERE item_id = ?
      `);
      const sourceInsert = this.db!.prepare(`
        INSERT OR IGNORE INTO context_item_sources (
          item_id, source_kind, source_id, created_at
        )
        VALUES (?, 'context_item', ?, ?)
      `);
      for (const row of rows) {
        archive.run(now, row.item_id);
        sourceInsert.run(summaryItemId, row.item_id, now);
      }
      return {
        compactedCount: rows.length,
        summaryItemId
      };
    });
    const result = compact() as { compactedCount: number; summaryItemId?: string };
    if (result.compactedCount > 0) {
      this.logger.info({ userId: input.userId, ...result }, "context_user_chunks_compacted");
    }
    return result;
  }

  upsertRawMessages(messages: ContextRawMessage[]): void {
    if (!this.db || messages.length === 0) {
      return;
    }
    const upsert = this.db.prepare(`
      INSERT INTO raw_messages (
        message_id, user_id, session_id, chat_type, role, speaker_id,
        timestamp_ms, text, segments_json, attachment_refs_json,
        sensitivity, ingested_at
      )
      VALUES (
        @messageId, @userId, @sessionId, @chatType, @role, @speakerId,
        @timestampMs, @text, @segmentsJson, @attachmentRefsJson,
        @sensitivity, @ingestedAt
      )
      ON CONFLICT(message_id) DO UPDATE SET
        user_id = excluded.user_id,
        session_id = excluded.session_id,
        chat_type = excluded.chat_type,
        role = excluded.role,
        speaker_id = excluded.speaker_id,
        timestamp_ms = excluded.timestamp_ms,
        text = excluded.text,
        segments_json = excluded.segments_json,
        attachment_refs_json = excluded.attachment_refs_json,
        sensitivity = excluded.sensitivity
    `);
    const write = this.db.transaction(() => {
      for (const message of messages) {
        upsert.run({
          messageId: message.messageId,
          userId: message.userId,
          sessionId: message.sessionId,
          chatType: message.chatType,
          role: message.role,
          speakerId: message.speakerId ?? null,
          timestampMs: message.timestampMs,
          text: message.text,
          segmentsJson: message.segments === undefined ? null : JSON.stringify(message.segments),
          attachmentRefsJson: message.attachmentRefs === undefined ? null : JSON.stringify(message.attachmentRefs),
          sensitivity: message.sensitivity,
          ingestedAt: message.ingestedAt
        });
      }
    });
    write();
  }

  upsertUserSearchChunk(input: {
    itemId: string;
    userId: string;
    sessionId: string;
    title?: string;
    text: string;
    source?: string;
    createdAt: number;
    updatedAt: number;
  }): void {
    if (!this.db) {
      return;
    }
    if (!input.text.trim()) {
      return;
    }
    this.upsertContextItem({
      itemId: input.itemId,
      scope: "user",
      sourceType: "chunk",
      retrievalPolicy: "search",
      status: "active",
      userId: input.userId,
      sessionId: input.sessionId,
      ...(input.title ? { title: input.title } : {}),
      text: input.text,
      ...(input.source ? { source: input.source } : {}),
      sensitivity: "normal",
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      retrievedCount: 0
    });
  }

  upsertConversationEpisode(input: {
    itemId: string;
    userId: string;
    sessionId: string;
    title?: string;
    text: string;
    source?: string;
    createdAt: number;
    updatedAt: number;
  }): void {
    if (!this.db || !input.text.trim()) {
      return;
    }
    this.upsertContextItem({
      itemId: input.itemId,
      scope: "user",
      sourceType: "episode",
      retrievalPolicy: "never",
      status: "active",
      userId: input.userId,
      sessionId: input.sessionId,
      ...(input.title ? { title: input.title } : {}),
      text: input.text,
      ...(input.source ? { source: input.source } : {}),
      sensitivity: "normal",
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      retrievedCount: 0
    });
  }

  sweepUserSearchChunks(input: {
    userId: string;
    maxChunks: number;
    maxAgeMs: number;
    now?: number;
  }): {
    deletedCount: number;
  } {
    const db = this.db;
    if (!db) {
      return { deletedCount: 0 };
    }
    const now = input.now ?? Date.now();
    const cutoff = now - input.maxAgeMs;
    const sweep = db.transaction(() => {
      const oldRows = db.prepare(`
        SELECT item_id
        FROM context_items
        WHERE scope = 'user'
          AND source_type = 'chunk'
          AND retrieval_policy = 'search'
          AND status = 'active'
          AND pinned = 0
          AND user_id = ?
          AND updated_at < ?
      `).all(input.userId, cutoff) as Array<{ item_id: string }>;
      const activeRows = db.prepare(`
        SELECT item_id
        FROM context_items
        WHERE scope = 'user'
          AND source_type = 'chunk'
          AND retrieval_policy = 'search'
          AND status = 'active'
          AND pinned = 0
          AND user_id = ?
        ORDER BY updated_at DESC, created_at DESC, item_id DESC
      `).all(input.userId) as Array<{ item_id: string }>;
      const overQuotaRows = activeRows.slice(Math.max(0, input.maxChunks));
      const deleteIds = Array.from(new Set([
        ...oldRows.map((row) => row.item_id),
        ...overQuotaRows.map((row) => row.item_id)
      ]));
      if (deleteIds.length === 0) {
        return 0;
      }
      db.prepare(`
        DELETE FROM context_items
        WHERE item_id IN (${deleteIds.map(() => "?").join(",")})
      `).run(...deleteIds);
      return deleteIds.length;
    });
    const deletedCount = sweep() as number;
    if (deletedCount > 0) {
      this.logger.info({
        userId: input.userId,
        deletedCount,
        maxChunks: input.maxChunks,
        maxAgeMs: input.maxAgeMs
      }, "context_user_search_chunks_swept");
    }
    return { deletedCount };
  }

  listUserSearchDocuments(userId: string): ContextSearchDocument[] {
    return this.listUserDocumentsByRetrievalPolicy(userId, "search");
  }

  listUserAlwaysDocuments(userId: string): ContextSearchDocument[] {
    return this.listUserDocumentsByRetrievalPolicy(userId, "always");
  }

  recordRetrievedContextItems(input: {
    itemIds: Iterable<string>;
    now?: number;
  }): number {
    const ids = Array.from(new Set(Array.from(input.itemIds).map((item) => item.trim()).filter(Boolean)));
    if (!this.db || ids.length === 0) {
      return 0;
    }
    const now = input.now ?? Date.now();
    const result = this.db.prepare(`
      UPDATE context_items
      SET retrieved_count = retrieved_count + 1,
          last_retrieved_at = ?,
          audit_state = NULL
      WHERE item_id IN (${ids.map(() => "?").join(",")})
        AND status = 'active'
    `).run(now, ...ids);
    return result.changes;
  }

  recordPromptedContextItems(input: {
    itemIds: Iterable<string>;
    now?: number;
  }): number {
    const ids = Array.from(new Set(Array.from(input.itemIds).map((item) => item.trim()).filter(Boolean)));
    if (!this.db || ids.length === 0) {
      return 0;
    }
    const now = input.now ?? Date.now();
    const result = this.db.prepare(`
      UPDATE context_items
      SET prompted_count = prompted_count + 1,
          last_prompted_at = ?,
          audit_state = NULL
      WHERE item_id IN (${ids.map(() => "?").join(",")})
        AND status = 'active'
    `).run(now, ...ids);
    return result.changes;
  }

  auditMemoryVisibility(input: {
    staleAfterMs: number;
    now?: number;
    limit?: number;
  }): {
    auditedCount: number;
    itemIds: string[];
  } {
    if (!this.db) {
      return { auditedCount: 0, itemIds: [] };
    }
    const now = input.now ?? Date.now();
    const cutoff = now - Math.max(0, input.staleAfterMs);
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const rows = this.db.prepare(`
      SELECT *
      FROM context_items
      WHERE status = 'active'
        AND layer = 'searchable_fact'
        AND retrieval_policy = 'search'
        AND pinned = 0
        AND updated_at < @cutoff
        AND (last_prompted_at IS NULL OR last_prompted_at < @cutoff)
        AND (last_retrieved_at IS NULL OR last_retrieved_at < @cutoff)
        AND (last_audited_at IS NULL OR last_audited_at < @cutoff)
      ORDER BY updated_at ASC, item_id ASC
      LIMIT @limit
    `).all({ cutoff, limit }) as ContextItemRow[];
    if (rows.length === 0) {
      return { auditedCount: 0, itemIds: [] };
    }
    const update = this.db.prepare(`
      UPDATE context_items
      SET audit_state = 'unreachable',
          last_audited_at = @now
      WHERE item_id = @itemId
    `);
    const audit = this.db.transaction(() => {
      for (const row of rows) {
        update.run({ itemId: row.item_id, now });
        this.addManualAuditEvent({
          eventType: "memory_unreachable",
          itemId: row.item_id,
          payload: {
            reason: "not_prompted_or_retrieved_within_window",
            staleAfterMs: input.staleAfterMs,
            lastPromptedAt: row.last_prompted_at,
            lastRetrievedAt: row.last_retrieved_at,
            updatedAt: row.updated_at
          },
          createdAt: now
        });
      }
    });
    audit();
    const itemIds = rows.map((row) => row.item_id);
    this.logger.info({ auditedCount: itemIds.length }, "context_memory_visibility_audited");
    return { auditedCount: itemIds.length, itemIds };
  }

  private listUserDocumentsByRetrievalPolicy(
    userId: string,
    retrievalPolicy: ContextSearchDocument["retrievalPolicy"]
  ): ContextSearchDocument[] {
    if (!this.db) {
      return [];
    }
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT *
      FROM context_items
      WHERE scope = 'user'
        AND status = 'active'
        AND user_id = ?
        AND retrieval_policy = ?
        AND sensitivity != 'secret'
        AND (audit_state IS NULL OR audit_state != 'unreachable')
        AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY updated_at DESC
    `).all(userId, retrievalPolicy, now) as ContextItemRow[];
    return rows.map(rowToContextSearchDocument);
  }

  getItemEmbeddings(
    itemIds: string[],
    embeddingProfileId: string,
    expectedTextHashes?: Map<string, string>
  ): Map<string, number[]> {
    if (!this.db || itemIds.length === 0) {
      return new Map();
    }
    const rows = this.db.prepare(`
      SELECT item_id, text_hash, vector
      FROM context_item_embeddings
      WHERE embedding_profile_id = ?
        AND item_id IN (${itemIds.map(() => "?").join(",")})
    `).all(embeddingProfileId, ...itemIds) as Array<{
      item_id: string;
      text_hash: string;
      vector: Buffer;
    }>;
    return new Map(rows
      .filter((row) => !expectedTextHashes || expectedTextHashes.get(row.item_id) === row.text_hash)
      .map((row) => [row.item_id, decodeVector(row.vector)]));
  }

  upsertEmbeddingProfile(profile: ContextEmbeddingProfile): void {
    const now = Date.now();
    this.requireDb().prepare(`
      INSERT INTO embedding_profiles (
        profile_id, instance_name, provider, model, dimension, distance,
        text_preprocess_version, chunker_version, active, created_at
      )
      VALUES (
        @profileId, @instanceName, @provider, @model, @dimension, @distance,
        @textPreprocessVersion, @chunkerVersion, 1, @createdAt
      )
      ON CONFLICT(profile_id) DO UPDATE SET
        active = 1
    `).run({
      profileId: profile.profileId,
      instanceName: profile.instanceName,
      provider: profile.provider,
      model: profile.model,
      dimension: profile.dimension,
      distance: profile.distance,
      textPreprocessVersion: profile.textPreprocessVersion,
      chunkerVersion: profile.chunkerVersion,
      createdAt: now
    });
  }

  upsertItemEmbedding(input: {
    itemId: string;
    embeddingProfileId: string;
    textHash: string;
    vector: number[];
  }): void {
    const now = Date.now();
    this.requireDb().prepare(`
      INSERT INTO context_item_embeddings (
        item_id, embedding_profile_id, text_hash, dimension, vector, created_at, updated_at
      )
      VALUES (
        @itemId, @embeddingProfileId, @textHash, @dimension, @vector, @createdAt, @updatedAt
      )
      ON CONFLICT(item_id, embedding_profile_id) DO UPDATE SET
        text_hash = excluded.text_hash,
        dimension = excluded.dimension,
        vector = excluded.vector,
        updated_at = excluded.updated_at
    `).run({
      itemId: input.itemId,
      embeddingProfileId: input.embeddingProfileId,
      textHash: input.textHash,
      dimension: input.vector.length,
      vector: encodeVector(input.vector),
      createdAt: now,
      updatedAt: now
    });
  }

  private upsertContextItem(item: ContextItem): void {
    this.requireDb().prepare(`
      INSERT INTO context_items (
        item_id, scope, layer, subject_kind, subject_id, source_type, retrieval_policy, status,
        user_id, session_id, toolset_id, mode_id,
        title, slot_key, text, embedding_text_hash, kind, source, confidence, importance, pinned, sensitivity,
        created_at, updated_at, valid_from, valid_to, superseded_by,
        last_confirmed_at, retrieved_count, last_retrieved_at,
        prompted_count, last_prompted_at, last_audited_at, audit_state
      )
      VALUES (
        @itemId, @scope, @layer, @subjectKind, @subjectId, @sourceType, @retrievalPolicy, @status,
        @userId, @sessionId, @toolsetId, @modeId,
        @title, @slotKey, @text, @embeddingTextHash, @kind, @source, @confidence, @importance, @pinned, @sensitivity,
        @createdAt, @updatedAt, @validFrom, @validTo, @supersededBy,
        @lastConfirmedAt, @retrievedCount, @lastRetrievedAt,
        @promptedCount, @lastPromptedAt, @lastAuditedAt, @auditState
      )
      ON CONFLICT(item_id) DO UPDATE SET
        scope = excluded.scope,
        layer = excluded.layer,
        subject_kind = excluded.subject_kind,
        subject_id = excluded.subject_id,
        source_type = excluded.source_type,
        retrieval_policy = excluded.retrieval_policy,
        status = excluded.status,
        user_id = excluded.user_id,
        session_id = excluded.session_id,
        toolset_id = excluded.toolset_id,
        mode_id = excluded.mode_id,
        title = excluded.title,
        slot_key = excluded.slot_key,
        text = excluded.text,
        embedding_text_hash = excluded.embedding_text_hash,
        kind = excluded.kind,
        source = excluded.source,
        confidence = excluded.confidence,
        importance = excluded.importance,
        pinned = excluded.pinned,
        sensitivity = excluded.sensitivity,
        updated_at = excluded.updated_at,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        superseded_by = excluded.superseded_by,
        last_confirmed_at = excluded.last_confirmed_at,
        retrieved_count = excluded.retrieved_count,
        last_retrieved_at = excluded.last_retrieved_at,
        prompted_count = context_items.prompted_count,
        last_prompted_at = context_items.last_prompted_at,
        last_audited_at = NULL,
        audit_state = NULL
    `).run(toSqlParams(item));
  }

  getContextItem(itemId: string): ContextManagementItem | null {
    if (!this.db) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT *
      FROM context_items
      WHERE item_id = ?
    `).get(itemId) as ContextItemRow | undefined;
    return row ? rowToContextManagementItem(row) : null;
  }

  private recalculateDerivedContextItemFields(itemId: string): void {
    const db = this.db;
    if (!db) {
      return;
    }
    const row = db.prepare(`
      SELECT *
      FROM context_items
      WHERE item_id = ?
    `).get(itemId) as ContextItemRow | undefined;
    if (!row) {
      return;
    }
    const scope = normalizeContextScope(row.scope);
    const sourceType = normalizeContextSourceType(row.source_type);
    const status = normalizeContextItemStatus(row.status);
    const layer = resolveStoredContextLayer({
      status,
      sourceType,
      retrievalPolicy: normalizeContextRetrievalPolicy(row.retrieval_policy),
      scope,
      slotKey: normalizeContextSlotKey(row.slot_key),
      kind: row.kind ?? undefined,
      importance: row.importance ?? undefined,
      pinned: row.pinned === 1
    });
    const subject = resolveContextSubject({
      scope,
      userId: row.user_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      toolsetId: row.toolset_id ?? undefined,
      modeId: row.mode_id ?? undefined
    });
    db.prepare(`
      UPDATE context_items
      SET layer = @layer,
          subject_kind = @subjectKind,
          subject_id = @subjectId,
          retrieval_policy = @retrievalPolicy,
          last_audited_at = NULL,
          audit_state = NULL
      WHERE item_id = @itemId
    `).run({
      itemId,
      layer,
      subjectKind: subject.subjectKind,
      subjectId: subject.subjectId ?? null,
      retrievalPolicy: resolveStoredRetrievalPolicy({
        layer,
        sourceType,
        currentPolicy: normalizeContextRetrievalPolicy(row.retrieval_policy)
      })
    });
  }

  private addContextItemSource(input: {
    itemId: string;
    sourceKind: string;
    sourceId: string;
    createdAt: number;
  }): void {
    this.requireDb().prepare(`
      INSERT OR IGNORE INTO context_item_sources (
        item_id, source_kind, source_id, created_at
      )
      VALUES (@itemId, @sourceKind, @sourceId, @createdAt)
    `).run(input);
  }

  private addManualAuditEvent(input: {
    eventType: string;
    itemId?: string;
    actorId?: string;
    payload: unknown;
    createdAt: number;
  }): void {
    const eventId = buildAuditEventId(input.eventType, input.itemId ?? "", input.createdAt, input.payload);
    this.requireDb().prepare(`
      INSERT OR IGNORE INTO manual_audit_events (
        event_id, event_type, actor_id, item_id, payload_json, created_at
      )
      VALUES (
        @eventId, @eventType, @actorId, @itemId, @payloadJson, @createdAt
      )
    `).run({
      eventId,
      eventType: input.eventType,
      actorId: input.actorId ?? null,
      itemId: input.itemId ?? null,
      payloadJson: JSON.stringify(input.payload),
      createdAt: input.createdAt
    });
  }

  private requireDb(): SqliteDatabase {
    if (!this.db) {
      throw new Error(this.disabledReason
        ? `ContextStore is unavailable: ${this.disabledReason}`
        : "ContextStore is not initialized");
    }
    return this.db;
  }
}

const CONTEXT_TABLE_GROUPS: SqliteTableGroupDefinition[] = [
  {
    groupId: "context.raw_messages",
    schemaVersion: 1,
    ownedTables: ["raw_messages"],
    ownedIndexes: ["idx_raw_messages_user_session_time"],
    createSchema: createRawMessagesSchema,
    validateSchema: validateRawMessagesSchema
  },
  {
    groupId: "context.items",
    schemaVersion: 2,
    ownedTables: ["context_items", "context_item_sources"],
    ownedIndexes: [
      "idx_context_items_user_lookup",
      "idx_context_items_session_lookup",
      "idx_context_items_toolset_lookup",
      "idx_context_items_mode_lookup",
      "idx_context_items_subject_lookup"
    ],
    createSchema: createContextItemsSchema,
    adoptExistingSchema: adoptExistingContextItemsSchema,
    validateSchema: validateContextItemsSchema
  },
  {
    groupId: "context.embeddings",
    schemaVersion: 1,
    ownedTables: ["context_item_embeddings", "embedding_profiles"],
    ownedIndexes: ["idx_context_embeddings_profile"],
    dependsOn: ["context.items"],
    createSchema: createContextEmbeddingsSchema,
    adoptExistingSchema: adoptExistingContextEmbeddingsSchema,
    validateSchema: validateContextEmbeddingsSchema
  },
  {
    groupId: "context.maintenance",
    schemaVersion: 1,
    ownedTables: ["maintenance_jobs", "manual_audit_events"],
    ownedIndexes: ["idx_maintenance_jobs_status_time"],
    createSchema: createContextMaintenanceSchema,
    validateSchema: validateContextMaintenanceSchema
  }
];

function createRawMessagesSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_messages (
      message_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      role TEXT NOT NULL,
      speaker_id TEXT,
      timestamp_ms INTEGER NOT NULL,
      text TEXT NOT NULL,
      segments_json TEXT,
      attachment_refs_json TEXT,
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      ingested_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_raw_messages_user_session_time
      ON raw_messages(user_id, session_id, timestamp_ms);
  `);
}

function validateRawMessagesSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "raw_messages", {
    message_id: "TEXT",
    user_id: "TEXT",
    session_id: "TEXT",
    chat_type: "TEXT",
    role: "TEXT",
    speaker_id: "TEXT",
    timestamp_ms: "INTEGER",
    text: "TEXT",
    segments_json: "TEXT",
    attachment_refs_json: "TEXT",
    sensitivity: "TEXT",
    ingested_at: "INTEGER"
  });
  assertIndexExists(db, "idx_raw_messages_user_session_time");
}

function createContextItemsSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_items (
      item_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      layer TEXT NOT NULL DEFAULT 'searchable_fact',
      subject_kind TEXT NOT NULL DEFAULT 'global',
      subject_id TEXT,
      source_type TEXT NOT NULL,
      retrieval_policy TEXT NOT NULL,
      status TEXT NOT NULL,
      user_id TEXT,
      session_id TEXT,
      toolset_id TEXT,
      mode_id TEXT,
      title TEXT,
      slot_key TEXT,
      text TEXT NOT NULL,
      embedding_text_hash TEXT,
      kind TEXT,
      source TEXT,
      confidence REAL,
      importance INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0,
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      valid_from INTEGER,
      valid_to INTEGER,
      superseded_by TEXT,
      last_confirmed_at INTEGER,
      retrieved_count INTEGER NOT NULL DEFAULT 0,
      last_retrieved_at INTEGER,
      prompted_count INTEGER NOT NULL DEFAULT 0,
      last_prompted_at INTEGER,
      last_audited_at INTEGER,
      audit_state TEXT
    );

    CREATE TABLE IF NOT EXISTS context_item_sources (
      item_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, source_kind, source_id),
      FOREIGN KEY (item_id) REFERENCES context_items(item_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_context_items_user_lookup
      ON context_items(scope, user_id, source_type, status, retrieval_policy);
    CREATE INDEX IF NOT EXISTS idx_context_items_session_lookup
      ON context_items(scope, session_id, source_type, status);
    CREATE INDEX IF NOT EXISTS idx_context_items_toolset_lookup
      ON context_items(scope, toolset_id, source_type, status);
    CREATE INDEX IF NOT EXISTS idx_context_items_mode_lookup
      ON context_items(scope, mode_id, source_type, status);
  `);
  ensureContextItemsV2Columns(db);
}

function validateContextItemsSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "context_items", {
    item_id: "TEXT",
    scope: "TEXT",
    layer: "TEXT",
    subject_kind: "TEXT",
    subject_id: "TEXT",
    source_type: "TEXT",
    retrieval_policy: "TEXT",
    status: "TEXT",
    user_id: "TEXT",
    session_id: "TEXT",
    toolset_id: "TEXT",
    mode_id: "TEXT",
    title: "TEXT",
    slot_key: "TEXT",
    text: "TEXT",
    embedding_text_hash: "TEXT",
    kind: "TEXT",
    source: "TEXT",
    confidence: "REAL",
    importance: "INTEGER",
    pinned: "INTEGER",
    sensitivity: "TEXT",
    created_at: "INTEGER",
    updated_at: "INTEGER",
    valid_from: "INTEGER",
    valid_to: "INTEGER",
    superseded_by: "TEXT",
    last_confirmed_at: "INTEGER",
    retrieved_count: "INTEGER",
    last_retrieved_at: "INTEGER",
    prompted_count: "INTEGER",
    last_prompted_at: "INTEGER",
    last_audited_at: "INTEGER",
    audit_state: "TEXT"
  });
  assertTableColumns(db, "context_item_sources", {
    item_id: "TEXT",
    source_kind: "TEXT",
    source_id: "TEXT",
    created_at: "INTEGER"
  });
  assertIndexExists(db, "idx_context_items_user_lookup");
  assertIndexExists(db, "idx_context_items_session_lookup");
  assertIndexExists(db, "idx_context_items_toolset_lookup");
  assertIndexExists(db, "idx_context_items_mode_lookup");
  assertIndexExists(db, "idx_context_items_subject_lookup");
}

function adoptExistingContextItemsSchema(db: SqliteDatabase): void {
  createContextItemsSchema(db);
  ensureContextItemsV2Columns(db);
  addColumnIfMissing(db, "context_items", "embedding_text_hash", "TEXT");
  addColumnIfMissing(db, "context_items", "slot_key", "TEXT");
  backfillContextItemsV2Columns(db);
}

function ensureContextItemsV2Columns(db: SqliteDatabase): void {
  addColumnIfMissing(db, "context_items", "layer", "TEXT NOT NULL DEFAULT 'searchable_fact'");
  addColumnIfMissing(db, "context_items", "subject_kind", "TEXT NOT NULL DEFAULT 'global'");
  addColumnIfMissing(db, "context_items", "subject_id", "TEXT");
  addColumnIfMissing(db, "context_items", "prompted_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "context_items", "last_prompted_at", "INTEGER");
  addColumnIfMissing(db, "context_items", "last_audited_at", "INTEGER");
  addColumnIfMissing(db, "context_items", "audit_state", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_context_items_subject_lookup
      ON context_items(subject_kind, subject_id, layer, status, retrieval_policy);
  `);
}

function backfillContextItemsV2Columns(db: SqliteDatabase): void {
  const rows = db.prepare("SELECT * FROM context_items").all() as Partial<ContextItemRow>[];
  const update = db.prepare(`
    UPDATE context_items
    SET layer = @layer,
        subject_kind = @subjectKind,
        subject_id = @subjectId,
        retrieval_policy = @retrievalPolicy
    WHERE item_id = @itemId
  `);
  for (const row of rows) {
    if (!row.item_id) {
      continue;
    }
    const scope = normalizeContextScope(row.scope);
    const sourceType = normalizeContextSourceType(row.source_type);
    const status = normalizeContextItemStatus(row.status);
    const layer = resolveStoredContextLayer({
      layer: normalizeContextMemoryLayer(row.layer),
      status,
      sourceType,
      retrievalPolicy: normalizeContextRetrievalPolicy(row.retrieval_policy),
      scope,
      slotKey: normalizeContextSlotKey(row.slot_key),
      kind: typeof row.kind === "string" ? row.kind : undefined,
      importance: typeof row.importance === "number" ? row.importance : undefined,
      pinned: row.pinned === 1
    });
    const subject = resolveContextSubject({
      scope,
      userId: typeof row.user_id === "string" ? row.user_id : undefined,
      sessionId: typeof row.session_id === "string" ? row.session_id : undefined,
      toolsetId: typeof row.toolset_id === "string" ? row.toolset_id : undefined,
      modeId: typeof row.mode_id === "string" ? row.mode_id : undefined
    });
    update.run({
      itemId: row.item_id,
      layer,
      subjectKind: subject.subjectKind,
      subjectId: subject.subjectId ?? null,
      retrievalPolicy: resolveStoredRetrievalPolicy({
        layer,
        sourceType,
        currentPolicy: normalizeContextRetrievalPolicy(row.retrieval_policy)
      })
    });
  }
}

function createContextEmbeddingsSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_item_embeddings (
      item_id TEXT NOT NULL,
      embedding_profile_id TEXT NOT NULL,
      text_hash TEXT NOT NULL DEFAULT '',
      dimension INTEGER NOT NULL,
      vector BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, embedding_profile_id),
      FOREIGN KEY (item_id) REFERENCES context_items(item_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS embedding_profiles (
      profile_id TEXT PRIMARY KEY,
      instance_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      distance TEXT NOT NULL,
      text_preprocess_version TEXT NOT NULL,
      chunker_version TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_context_embeddings_profile
      ON context_item_embeddings(embedding_profile_id, item_id);
  `);
}

function validateContextEmbeddingsSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "context_item_embeddings", {
    item_id: "TEXT",
    embedding_profile_id: "TEXT",
    text_hash: "TEXT",
    dimension: "INTEGER",
    vector: "BLOB",
    created_at: "INTEGER",
    updated_at: "INTEGER"
  });
  assertTableColumns(db, "embedding_profiles", {
    profile_id: "TEXT",
    instance_name: "TEXT",
    provider: "TEXT",
    model: "TEXT",
    dimension: "INTEGER",
    distance: "TEXT",
    text_preprocess_version: "TEXT",
    chunker_version: "TEXT",
    active: "INTEGER",
    created_at: "INTEGER"
  });
  assertIndexExists(db, "idx_context_embeddings_profile");
}

function adoptExistingContextEmbeddingsSchema(db: SqliteDatabase): void {
  createContextEmbeddingsSchema(db);
  addColumnIfMissing(db, "context_item_embeddings", "text_hash", "TEXT NOT NULL DEFAULT ''");
}

function createContextMaintenanceSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_jobs (
      job_id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS manual_audit_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      actor_id TEXT,
      item_id TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_status_time
      ON maintenance_jobs(status, scheduled_at);
  `);
}

function validateContextMaintenanceSchema(db: SqliteDatabase): void {
  assertTableColumns(db, "maintenance_jobs", {
    job_id: "TEXT",
    job_type: "TEXT",
    status: "TEXT",
    payload_json: "TEXT",
    scheduled_at: "INTEGER",
    started_at: "INTEGER",
    finished_at: "INTEGER",
    error: "TEXT"
  });
  assertTableColumns(db, "manual_audit_events", {
    event_id: "TEXT",
    event_type: "TEXT",
    actor_id: "TEXT",
    item_id: "TEXT",
    payload_json: "TEXT",
    created_at: "INTEGER"
  });
  assertIndexExists(db, "idx_maintenance_jobs_status_time");
}

function addColumnIfMissing(db: SqliteDatabase, tableName: string, columnName: string, definition: string): void {
  const table = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
  `).get(tableName) as { name: string } | undefined;
  if (!table) {
    return;
  }
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function rowToContextMemoryFactEntry(row: ContextItemRow): ContextMemoryFactEntry {
  const memory = createUserMemoryEntry({
    id: row.item_id,
    title: row.title ?? "长期事实",
    content: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.kind ? { kind: row.kind as UserMemoryEntry["kind"] } : {}),
    ...(row.source ? { source: row.source as UserMemoryEntry["source"] } : {}),
    ...(row.importance !== null ? { importance: row.importance } : {}),
    ...(row.last_retrieved_at !== null ? { lastUsedAt: row.last_retrieved_at } : {})
  });
  return {
    ...memory,
    ...(normalizeContextSlotKey(row.slot_key) ? { slotKey: normalizeContextSlotKey(row.slot_key)! } : {})
  };
}

function rowToContextSearchDocument(row: ContextItemRow): ContextSearchDocument {
  return {
    itemId: row.item_id,
    scope: row.scope as ContextSearchDocument["scope"],
    layer: normalizeContextMemoryLayer(row.layer) ?? "searchable_fact",
    subjectKind: normalizeContextSubjectKind(row.subject_kind),
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
    sourceType: row.source_type as ContextSearchDocument["sourceType"],
    retrievalPolicy: row.retrieval_policy as ContextSearchDocument["retrievalPolicy"],
    ...(row.user_id ? { userId: row.user_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(normalizeContextSlotKey(row.slot_key) ? { slotKey: normalizeContextSlotKey(row.slot_key)! } : {}),
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.importance !== null ? { importance: row.importance } : {}),
    text: row.text,
    embeddingTextHash: row.embedding_text_hash ?? buildContextEmbeddingTextHash(row.text),
    updatedAt: row.updated_at,
    ...(row.last_retrieved_at !== null ? { lastRetrievedAt: row.last_retrieved_at } : {})
  };
}

function rowToContextManagementItem(row: ContextItemRow): ContextManagementItem {
  return {
    itemId: row.item_id,
    scope: row.scope as ContextManagementItem["scope"],
    layer: normalizeContextMemoryLayer(row.layer) ?? "searchable_fact",
    subjectKind: normalizeContextSubjectKind(row.subject_kind),
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
    sourceType: row.source_type as ContextManagementItem["sourceType"],
    retrievalPolicy: row.retrieval_policy as ContextManagementItem["retrievalPolicy"],
    status: row.status as ContextManagementItem["status"],
    ...(row.user_id ? { userId: row.user_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.toolset_id ? { toolsetId: row.toolset_id } : {}),
    ...(row.mode_id ? { modeId: row.mode_id } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(normalizeContextSlotKey(row.slot_key) ? { slotKey: normalizeContextSlotKey(row.slot_key)! } : {}),
    text: row.text,
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.source ? { source: row.source } : {}),
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    ...(row.importance !== null ? { importance: row.importance } : {}),
    pinned: row.pinned === 1,
    sensitivity: row.sensitivity as ContextManagementItem["sensitivity"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.valid_from !== null ? { validFrom: row.valid_from } : {}),
    ...(row.valid_to !== null ? { validTo: row.valid_to } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.last_confirmed_at !== null ? { lastConfirmedAt: row.last_confirmed_at } : {}),
    retrievedCount: row.retrieved_count,
    ...(row.last_retrieved_at !== null ? { lastRetrievedAt: row.last_retrieved_at } : {}),
    promptedCount: row.prompted_count,
    ...(row.last_prompted_at !== null ? { lastPromptedAt: row.last_prompted_at } : {}),
    ...(row.last_audited_at !== null ? { lastAuditedAt: row.last_audited_at } : {}),
    ...(row.audit_state ? { auditState: row.audit_state } : {})
  };
}

function rowToContextItem(row: ContextItemRow): ContextItem {
  return {
    itemId: row.item_id,
    scope: row.scope as ContextItem["scope"],
    layer: normalizeContextMemoryLayer(row.layer) ?? "searchable_fact",
    subjectKind: normalizeContextSubjectKind(row.subject_kind),
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
    sourceType: row.source_type as ContextItem["sourceType"],
    retrievalPolicy: row.retrieval_policy as ContextItem["retrievalPolicy"],
    status: row.status as ContextItem["status"],
    ...(row.user_id ? { userId: row.user_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.toolset_id ? { toolsetId: row.toolset_id } : {}),
    ...(row.mode_id ? { modeId: row.mode_id } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(normalizeContextSlotKey(row.slot_key) ? { slotKey: normalizeContextSlotKey(row.slot_key)! } : {}),
    text: row.text,
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.source ? { source: row.source } : {}),
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    ...(row.importance !== null ? { importance: row.importance } : {}),
    pinned: row.pinned === 1,
    sensitivity: row.sensitivity as ContextItem["sensitivity"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.valid_from !== null ? { validFrom: row.valid_from } : {}),
    ...(row.valid_to !== null ? { validTo: row.valid_to } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.last_confirmed_at !== null ? { lastConfirmedAt: row.last_confirmed_at } : {}),
    retrievedCount: row.retrieved_count,
    ...(row.last_retrieved_at !== null ? { lastRetrievedAt: row.last_retrieved_at } : {}),
    promptedCount: row.prompted_count,
    ...(row.last_prompted_at !== null ? { lastPromptedAt: row.last_prompted_at } : {}),
    ...(row.last_audited_at !== null ? { lastAuditedAt: row.last_audited_at } : {}),
    ...(row.audit_state ? { auditState: row.audit_state } : {})
  };
}

function parseContextItemImportLine(line: string): ContextItem | null {
  try {
    const parsed = JSON.parse(line) as Partial<ContextItem>;
    if (!parsed.itemId || !parsed.scope || !parsed.sourceType || !parsed.retrievalPolicy || !parsed.status || !parsed.text || !parsed.sensitivity) {
      return null;
    }
    const now = Date.now();
    return {
      itemId: parsed.itemId,
      scope: parsed.scope,
      ...(parsed.layer ? { layer: parsed.layer } : {}),
      ...(parsed.subjectKind ? { subjectKind: parsed.subjectKind } : {}),
      ...(parsed.subjectId ? { subjectId: parsed.subjectId } : {}),
      sourceType: parsed.sourceType,
      retrievalPolicy: parsed.retrievalPolicy,
      status: parsed.status,
      ...(parsed.userId ? { userId: parsed.userId } : {}),
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      ...(parsed.toolsetId ? { toolsetId: parsed.toolsetId } : {}),
      ...(parsed.modeId ? { modeId: parsed.modeId } : {}),
      ...(parsed.title ? { title: parsed.title } : {}),
      ...(normalizeContextSlotKey(parsed.slotKey) ? { slotKey: normalizeContextSlotKey(parsed.slotKey)! } : {}),
      text: parsed.text,
      ...(parsed.kind ? { kind: parsed.kind } : {}),
      ...(parsed.source ? { source: parsed.source } : {}),
      ...(typeof parsed.confidence === "number" ? { confidence: parsed.confidence } : {}),
      ...(typeof parsed.importance === "number" ? { importance: parsed.importance } : {}),
      pinned: parsed.pinned === true,
      sensitivity: parsed.sensitivity,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : now,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : now,
      ...(typeof parsed.validFrom === "number" ? { validFrom: parsed.validFrom } : {}),
      ...(typeof parsed.validTo === "number" ? { validTo: parsed.validTo } : {}),
      ...(parsed.supersededBy ? { supersededBy: parsed.supersededBy } : {}),
      ...(typeof parsed.lastConfirmedAt === "number" ? { lastConfirmedAt: parsed.lastConfirmedAt } : {}),
      retrievedCount: typeof parsed.retrievedCount === "number" ? parsed.retrievedCount : 0,
      ...(typeof parsed.lastRetrievedAt === "number" ? { lastRetrievedAt: parsed.lastRetrievedAt } : {}),
      ...(typeof parsed.promptedCount === "number" ? { promptedCount: parsed.promptedCount } : {}),
      ...(typeof parsed.lastPromptedAt === "number" ? { lastPromptedAt: parsed.lastPromptedAt } : {}),
      ...(typeof parsed.lastAuditedAt === "number" ? { lastAuditedAt: parsed.lastAuditedAt } : {}),
      ...(parsed.auditState ? { auditState: parsed.auditState } : {})
    };
  } catch {
    return null;
  }
}

function findSameSlotUserFact(title: string, facts: UserMemoryEntry[]): UserMemoryEntry | null {
  const normalizedTitle = normalizeTitleForDedup(title);
  if (!isSpecificUserFactTitle(normalizedTitle)) {
    return null;
  }
  return facts.find((item) => normalizeTitleForDedup(item.title) === normalizedTitle) ?? null;
}

function findSameSlotKeyFacts(slotKey: string, facts: ContextMemoryFactEntry[]): ContextMemoryFactEntry[] {
  const normalizedSlotKey = normalizeContextSlotKey(slotKey);
  if (!normalizedSlotKey) {
    return [];
  }
  return facts.filter((item) => normalizeContextSlotKey(item.slotKey) === normalizedSlotKey);
}

function collectSupersedeTargets(facts: ContextMemoryFactEntry[], ids: string[]): ContextMemoryFactEntry[] {
  const factsById = new Map(facts.map((item) => [item.id, item]));
  const targets: ContextMemoryFactEntry[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    const fact = factsById.get(id);
    if (!fact) {
      continue;
    }
    seen.add(id);
    targets.push(fact);
  }
  return targets;
}

function normalizeContextSlotKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized || normalized.length > 80) {
    return null;
  }
  for (const char of normalized) {
    const code = char.charCodeAt(0);
    const isLowerAscii = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isLowerAscii && !isDigit && char !== "_") {
      return null;
    }
  }
  return normalized;
}

function normalizeContextSlotKeyOrThrow(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return undefined;
  }
  const normalized = normalizeContextSlotKey(value);
  if (!normalized) {
    throw new Error("slotKey must contain only lowercase ASCII letters, digits, and underscores");
  }
  return normalized;
}

function normalizeContextScope(value: unknown): ContextItem["scope"] {
  return value === "session"
    || value === "user"
    || value === "global"
    || value === "toolset"
    || value === "mode"
    ? value
    : "global";
}

function normalizeContextSourceType(value: unknown): ContextItem["sourceType"] {
  return value === "episode"
    || value === "chunk"
    || value === "summary"
    || value === "fact"
    || value === "rule"
    ? value
    : "fact";
}

function normalizeContextRetrievalPolicy(value: unknown): ContextItem["retrievalPolicy"] {
  return value === "always" || value === "search" || value === "never" ? value : "search";
}

function normalizeContextItemStatus(value: unknown): ContextItem["status"] {
  return value === "active"
    || value === "archived"
    || value === "deleted"
    || value === "superseded"
    || value === "pending"
    ? value
    : "active";
}

function normalizeContextMemoryLayer(value: unknown): ContextMemoryLayer | undefined {
  return value === "profile_slot"
    || value === "core_fact"
    || value === "searchable_fact"
    || value === "episode"
    || value === "proposal"
    ? value
    : undefined;
}

function normalizeContextSubjectKind(value: unknown): ContextSubjectKind {
  return value === "session"
    || value === "user"
    || value === "global"
    || value === "toolset"
    || value === "mode"
    ? value
    : "global";
}

function resolveContextSubject(input: {
  scope: ContextItem["scope"];
  userId?: string | undefined;
  sessionId?: string | undefined;
  toolsetId?: string | undefined;
  modeId?: string | undefined;
  subjectKind?: ContextSubjectKind | undefined;
  subjectId?: string | undefined;
}): {
  subjectKind: ContextSubjectKind;
  subjectId?: string;
} {
  if (input.subjectKind) {
    return {
      subjectKind: input.subjectKind,
      ...(input.subjectId ? { subjectId: input.subjectId } : {})
    };
  }
  switch (input.scope) {
    case "user":
      return { subjectKind: "user", ...(input.userId ? { subjectId: input.userId } : {}) };
    case "session":
      return { subjectKind: "session", ...(input.sessionId ? { subjectId: input.sessionId } : {}) };
    case "toolset":
      return { subjectKind: "toolset", ...(input.toolsetId ? { subjectId: input.toolsetId } : {}) };
    case "mode":
      return { subjectKind: "mode", ...(input.modeId ? { subjectId: input.modeId } : {}) };
    case "global":
    default:
      return { subjectKind: "global" };
  }
}

function assertConcreteSubject(scope: ContextItem["scope"], subject: {
  subjectKind: ContextSubjectKind;
  subjectId?: string;
}): void {
  if (scope === "global") {
    return;
  }
  if (!subject.subjectId) {
    throw new Error(`context ${scope} proposal requires a concrete subject id`);
  }
}

function resolveStoredContextLayer(input: {
  layer?: ContextMemoryLayer | undefined;
  status?: ContextItem["status"] | undefined;
  sourceType: ContextItem["sourceType"];
  retrievalPolicy?: ContextItem["retrievalPolicy"] | undefined;
  scope: ContextItem["scope"];
  slotKey?: string | null | undefined;
  kind?: string | undefined;
  importance?: number | undefined;
  pinned?: boolean | undefined;
}): ContextMemoryLayer {
  if (input.status === "pending" || input.layer === "proposal") {
    return "proposal";
  }
  if (input.layer) {
    return input.layer;
  }
  if (input.sourceType === "episode" || input.sourceType === "chunk" || input.sourceType === "summary") {
    return "episode";
  }
  if (input.sourceType === "rule") {
    return "core_fact";
  }
  if (input.scope === "session") {
    return "core_fact";
  }
  return resolveUserFactLayer({
    slotKey: input.slotKey ?? undefined,
    kind: input.kind,
    importance: input.importance,
    pinned: input.pinned === true,
    sourceType: input.sourceType
  });
}

function resolveUserFactLayer(input: {
  slotKey?: string | null | undefined;
  kind?: string | undefined;
  importance?: number | undefined;
  pinned?: boolean | undefined;
  sourceType: ContextItem["sourceType"];
}): ContextMemoryLayer {
  if (input.sourceType !== "fact") {
    return input.sourceType === "rule" ? "core_fact" : "episode";
  }
  if (input.slotKey && PROFILE_SLOT_KEYS.has(input.slotKey)) {
    return "profile_slot";
  }
  if (input.pinned || input.kind === "boundary" || (input.importance ?? 0) >= 4) {
    return "core_fact";
  }
  return "searchable_fact";
}

function resolveSessionFactLayer(input: {
  slotKey?: string | null | undefined;
  kind?: string | undefined;
  importance?: number | undefined;
  pinned?: boolean | undefined;
  sourceType: ContextItem["sourceType"];
}): ContextMemoryLayer {
  if (input.slotKey && SESSION_SLOT_KEYS.has(input.slotKey)) {
    return "profile_slot";
  }
  return input.pinned || input.kind === "boundary" || (input.importance ?? 0) >= 4
    ? "core_fact"
    : "searchable_fact";
}

function retrievalPolicyForLayer(layer: ContextMemoryLayer): ContextItem["retrievalPolicy"] {
  return layer === "searchable_fact" || layer === "episode" ? "search" : "always";
}

function resolveStoredRetrievalPolicy(input: {
  layer: ContextMemoryLayer;
  sourceType: ContextItem["sourceType"];
  currentPolicy?: ContextItem["retrievalPolicy"] | undefined;
}): ContextItem["retrievalPolicy"] {
  if (input.layer === "proposal") {
    return "never";
  }
  if (input.sourceType === "episode") {
    return "never";
  }
  if (input.sourceType === "chunk" || input.sourceType === "summary") {
    return "search";
  }
  return retrievalPolicyForLayer(input.layer);
}

function isRelatedToRemovedFact(row: ContextItemRow, fact: ContextItemRow): boolean {
  const rowText = [row.title, row.text].filter(Boolean).join(" ");
  const factTitle = fact.title ?? "";
  if (isSpecificUserFactTitle(normalizeTitleForDedup(factTitle)) && contextTermOverlapScore(rowText, factTitle) >= 0.18) {
    return true;
  }
  const factTerms = informativeContextTerms([fact.title, fact.text].filter(Boolean).join(" "));
  const rowTerms = informativeContextTerms(rowText);
  if (factTerms.size === 0 || rowTerms.size === 0) {
    return false;
  }
  let matched = 0;
  for (const term of factTerms) {
    if (rowTerms.has(term)) {
      matched += 1;
    }
  }
  return matched / factTerms.size >= 0.48;
}

function isSpecificUserFactTitle(title: string): boolean {
  return title.length >= 4 && !GENERIC_USER_FACT_TITLES.has(title);
}

const GENERIC_USER_FACT_TITLES = new Set([
  "偏好",
  "习惯",
  "事实",
  "其他",
  "用户偏好",
  "用户习惯",
  "长期记忆"
]);

const PROFILE_SLOT_KEYS = new Set([
  "preferred_name",
  "residence",
  "timezone",
  "occupation",
  "communication_preference",
  "relationship_note"
]);

const SESSION_SLOT_KEYS = new Set([
  "session_purpose",
  "project_focus"
]);

function scoreUserFactTextMatch(query: string, item: UserMemoryEntry): number {
  const target = [item.title, item.content].filter(Boolean).join(" ");
  const normalizedQuery = normalizeTextForContextMatch(query);
  const normalizedTarget = normalizeTextForContextMatch(target);
  if (!normalizedQuery || !normalizedTarget) {
    return 0;
  }
  if (item.id === query.trim()) {
    return 1;
  }
  if (normalizedQuery === normalizedTarget || normalizedTarget.includes(normalizedQuery)) {
    return 1;
  }
  if (normalizedQuery.includes(normalizedTarget)) {
    return 0.92;
  }
  const titleScore = item.title ? Math.max(
    contextTermOverlapScore(item.title, query),
    contextTermOverlapScore(query, item.title)
  ) : 0;
  const textScore = Math.max(
    contextTermOverlapScore(target, query),
    contextTermOverlapScore(query, target)
  );
  const bigramScore = bigramJaccardSimilarity(query, target);
  return Math.max(titleScore * 0.95, textScore * 0.85, bigramScore);
}

function resolveUniqueUserFactTextMatch(
  candidates: Array<{ item: UserMemoryEntry; score: number }>
): { item: UserMemoryEntry; score: number } | null {
  const top = candidates[0];
  if (!top || top.score < USER_FACT_TEXT_MATCH_UNIQUE_SCORE) {
    return null;
  }
  const second = candidates[1];
  if (second && top.score - second.score < USER_FACT_TEXT_MATCH_UNIQUE_GAP) {
    return null;
  }
  return top;
}

function normalizeTextForContextMatch(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

const USER_FACT_TEXT_MATCH_MIN_SCORE = 0.18;
const USER_FACT_TEXT_MATCH_UNIQUE_SCORE = 0.42;
const USER_FACT_TEXT_MATCH_UNIQUE_GAP = 0.12;

function buildContextItemWhere(
  input: ContextItemFilterInput,
  extraWhere: string[] = []
): {
  whereSql: string;
  params: Array<string | number>;
} {
  const where = [...extraWhere];
  const params: Array<string | number> = [];
  if (input.itemId) {
    where.push("item_id = ?");
    params.push(input.itemId);
  }
  if (input.userId) {
    where.push("user_id = ?");
    params.push(input.userId);
  }
  if (input.scope) {
    where.push("scope = ?");
    params.push(input.scope);
  }
  if (input.sourceType) {
    where.push("source_type = ?");
    params.push(input.sourceType);
  }
  if (input.status) {
    where.push("status = ?");
    params.push(input.status);
  }
  return {
    whereSql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params
  };
}

function getCount(db: SqliteDatabase, tableName: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count;
}

function buildMemoryProposalId(input: {
  scope: ContextItem["scope"];
  subjectKind: ContextSubjectKind;
  subjectId?: string;
  title: string;
  content: string;
}): string {
  return `ctx_proposal_${hashStableId([
    input.scope,
    input.subjectKind,
    input.subjectId ?? "",
    input.title,
    input.content
  ].join("\n")).slice(0, 24)}`;
}

function buildAuditEventId(eventType: string, itemId: string, createdAt: number, payload: unknown): string {
  return `ctx_audit_${hashStableId(`${eventType}\n${itemId}\n${createdAt}\n${JSON.stringify(payload)}`).slice(0, 24)}`;
}

function hashStableId(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

function encodeVector(vector: number[]): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index] ?? 0, index * Float32Array.BYTES_PER_ELEMENT);
  }
  return buffer;
}

function decodeVector(buffer: Buffer): number[] {
  const values: number[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += Float32Array.BYTES_PER_ELEMENT) {
    values.push(buffer.readFloatLE(offset));
  }
  return values;
}

function buildContextEmbeddingTextHash(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

function toSqlParams(item: ContextItem): Record<string, string | number | null> {
  const scope = normalizeContextScope(item.scope);
  const subject = resolveContextSubject({
    scope,
    userId: item.userId,
    sessionId: item.sessionId,
    toolsetId: item.toolsetId,
    modeId: item.modeId,
    subjectKind: item.subjectKind,
    subjectId: item.subjectId
  });
  const sourceType = normalizeContextSourceType(item.sourceType);
  const layer = resolveStoredContextLayer({
    layer: item.layer,
    status: item.status,
    sourceType,
    retrievalPolicy: item.retrievalPolicy,
    scope,
    slotKey: normalizeContextSlotKey(item.slotKey),
    kind: item.kind,
    importance: item.importance,
    pinned: item.pinned === true
  });
  return {
    itemId: item.itemId,
    scope,
    layer,
    subjectKind: subject.subjectKind,
    subjectId: subject.subjectId ?? null,
    sourceType,
    retrievalPolicy: resolveStoredRetrievalPolicy({
      layer,
      sourceType,
      currentPolicy: item.retrievalPolicy
    }),
    status: item.status,
    userId: item.userId ?? null,
    sessionId: item.sessionId ?? null,
    toolsetId: item.toolsetId ?? null,
    modeId: item.modeId ?? null,
    title: item.title ?? null,
    slotKey: normalizeContextSlotKeyOrThrow(item.slotKey) ?? null,
    text: item.text,
    embeddingTextHash: buildContextEmbeddingTextHash(item.text),
    kind: item.kind ?? null,
    source: item.source ?? null,
    confidence: item.confidence ?? null,
    importance: item.importance ?? null,
    pinned: item.pinned ? 1 : 0,
    sensitivity: item.sensitivity,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    validFrom: item.validFrom ?? null,
    validTo: item.validTo ?? null,
    supersededBy: item.supersededBy ?? null,
    lastConfirmedAt: item.lastConfirmedAt ?? null,
    retrievedCount: item.retrievedCount,
    lastRetrievedAt: item.lastRetrievedAt ?? null,
    promptedCount: item.promptedCount ?? 0,
    lastPromptedAt: item.lastPromptedAt ?? null,
    lastAuditedAt: item.lastAuditedAt ?? null,
    auditState: item.auditState ?? null
  };
}
