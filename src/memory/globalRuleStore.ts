import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { SqliteDatabase } from "#data/sqlite/sqliteService.ts";
import { StateDatabase } from "#data/state/stateDatabase.ts";
import { detectScopeConflict, type ScopeConflictWarning } from "./memoryCategory.ts";
import { createGlobalRuleEntry, globalRuleEntrySchema, globalRuleFileSchema, type GlobalRuleEntry } from "./globalRuleEntry.ts";
import { findBestDuplicateMatch, normalizeTitleForDedup } from "./similarity.ts";
import {
  buildMemoryDedupDetails,
  buildMemoryWriteDiagnostics,
  type MemoryDedupDetails,
  type MemoryWriteAction
} from "./writeResult.ts";

export interface GlobalRuleUpsertResult {
  action: MemoryWriteAction;
  finalAction: "created" | "updated_existing" | "warning_scope_conflict";
  dedup: MemoryDedupDetails;
  warning: ScopeConflictWarning | null;
  item: GlobalRuleEntry;
  rules: GlobalRuleEntry[];
}

export class GlobalRuleStore {
  constructor(
    dataDir: string,
    _config: Pick<AppConfig, "backup">,
    private readonly logger: Logger,
    private readonly stateDatabase = new StateDatabase(dataDir, logger)
  ) {
    void _config;
  }

  async init(): Promise<void> {
    await this.stateDatabase.init();
  }

  async list(): Promise<GlobalRuleEntry[]> {
    return this.readAll();
  }

  async getAll(): Promise<GlobalRuleEntry[]> {
    return this.readAll();
  }

  async getRow(ruleId: string): Promise<GlobalRuleEntry | null> {
    return (await this.readAll()).find((rule) => rule.id === ruleId) ?? null;
  }

  async createRow(value: unknown): Promise<GlobalRuleEntry> {
    const parsed = createGlobalRuleEntry(globalRuleEntryInput(value));
    if (await this.getRow(parsed.id)) {
      throw new Error(`Global rule ${parsed.id} already exists`);
    }
    await this.insertRule(parsed);
    return parsed;
  }

  async patchRow(ruleId: string, patch: Record<string, unknown>): Promise<GlobalRuleEntry> {
    const current = await this.getRow(ruleId);
    if (!current) {
      throw new Error(`Global rule ${ruleId} not found`);
    }
    const parsed = createGlobalRuleEntry(globalRuleEntryInput({ ...current, ...patch, id: ruleId }));
    await this.updateRule(parsed);
    return parsed;
  }

  async upsert(input: {
    ruleId?: string;
    title: string;
    content: string;
    kind?: GlobalRuleEntry["kind"];
    source?: GlobalRuleEntry["source"];
  }): Promise<GlobalRuleUpsertResult> {
    const rules = await this.readAll();
    const sourceText = `${normalizeTitleForDedup(input.title)} ${input.content}`;
    const duplicate = input.ruleId
      ? null
      : findBestDuplicateMatch(
          sourceText,
          rules,
          (item) => `${normalizeTitleForDedup(item.title)} ${item.content}`
        );
    const targetId = input.ruleId || duplicate?.item.id;
    const action = targetId && rules.some((item) => item.id === targetId)
      ? "updated_existing" as const
      : "created" as const;
    const nextRule = createGlobalRuleEntry({
      ...(targetId ? { id: targetId } : {}),
      title: input.title,
      content: input.content,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(duplicate ? { createdAt: duplicate.item.createdAt } : {})
    });
    const targetIndex = rules.findIndex((item) => item.id === nextRule.id);
    const item = targetIndex >= 0
      ? { ...nextRule, createdAt: rules[targetIndex]!.createdAt }
      : nextRule;
    if (targetIndex >= 0) {
      await this.updateRule(item);
    } else {
      await this.insertRule(item);
    }
    const dedup = buildMemoryDedupDetails({
      explicitId: input.ruleId ?? null,
      duplicateId: duplicate?.item.id ?? null,
      similarityScore: duplicate?.similarityScore ?? null,
      matchedExisting: targetIndex >= 0
    });
    const warning = detectScopeConflict({
      currentScope: "global_rules",
      title: input.title,
      content: input.content
    });
    const diagnostics = buildMemoryWriteDiagnostics({
      targetCategory: "global_rules",
      action,
      dedup,
      warning
    });
    this.logger.info({
      targetCategory: diagnostics.targetCategory,
      ruleId: item.id,
      action: diagnostics.action,
      finalAction: diagnostics.finalAction,
      dedupMatchedBy: diagnostics.dedup.matchedBy,
      dedupMatchedExistingId: diagnostics.dedup.matchedExistingId,
      dedupSimilarityScore: diagnostics.dedup.similarityScore,
      rerouteResult: diagnostics.reroute.result,
      rerouteSuggestedScope: diagnostics.reroute.suggestedScope,
      rerouteReason: diagnostics.reroute.reason
    }, "global_rule_upserted");
    if (warning) {
      this.logger.warn({
        targetCategory: "global_rules",
        ruleId: item.id,
        suggestedScope: warning.suggestedScope,
        reason: warning.reason
      }, "memory_scope_conflict_detected");
    }
    return {
      action,
      finalAction: diagnostics.finalAction,
      dedup,
      warning,
      item,
      rules: await this.readAll()
    };
  }

  async remove(ruleId: string): Promise<GlobalRuleEntry[]> {
    const rules = await this.readAll();
    const exists = rules.some((item) => item.id === ruleId);
    if (!exists) {
      return rules;
    }
    await this.stateDatabase.init();
    this.stateDatabase.getDb().prepare(`
      DELETE FROM global_rules
      WHERE id = ?
    `).run(ruleId);
    this.logger.info({ ruleId }, "global_rule_removed");
    return this.readAll();
  }

  async overwrite(rules: Array<{
    id?: string;
    title: string;
    content: string;
    kind?: GlobalRuleEntry["kind"];
    source?: GlobalRuleEntry["source"];
    createdAt?: number;
    updatedAt?: number;
  }>): Promise<GlobalRuleEntry[]> {
    const nextRules = rules.map((item) => createGlobalRuleEntry(item));
    await this.writeAll(nextRules);
    this.logger.info({ ruleCount: nextRules.length }, "global_rules_overwritten");
    return nextRules;
  }

  private async readAll(): Promise<GlobalRuleEntry[]> {
    try {
      await this.stateDatabase.init();
      const rows = this.stateDatabase.getDb().prepare(`
        SELECT
          id,
          title,
          content,
          kind,
          source,
          created_at_ms AS createdAt,
          updated_at_ms AS updatedAt
        FROM global_rules
        ORDER BY sort_order ASC, id ASC
      `).all() as GlobalRuleRow[];
      return globalRuleFileSchema.parse(rows.map((row) => createGlobalRuleEntry(row)));
    } catch (error) {
      this.logger.warn({ error }, "global_rule_store_load_failed");
      throw error;
    }
  }

  private async writeAll(rules: GlobalRuleEntry[]): Promise<void> {
    const validated = globalRuleFileSchema.parse(rules);
    await this.stateDatabase.init();
    this.stateDatabase.getDb().transaction((nextRules: GlobalRuleEntry[]) => {
      const db = this.stateDatabase.getDb();
      db.prepare("DELETE FROM global_rules").run();
      nextRules.forEach((rule, index) => insertGlobalRuleRow(db, rule, index + 1));
    })(validated);
  }

  private async insertRule(rule: GlobalRuleEntry): Promise<void> {
    await this.stateDatabase.init();
    insertGlobalRuleRow(this.stateDatabase.getDb(), rule, nextGlobalRuleSortOrder(this.stateDatabase.getDb()));
  }

  private async updateRule(rule: GlobalRuleEntry): Promise<void> {
    await this.stateDatabase.init();
    this.stateDatabase.getDb().prepare(`
      UPDATE global_rules
      SET
        title = @title,
        content = @content,
        kind = @kind,
        source = @source,
        created_at_ms = @createdAt,
        updated_at_ms = @updatedAt
      WHERE id = @id
    `).run(rule);
  }
}

type GlobalRuleRow = {
  id: string;
  title: string;
  content: string;
  kind: GlobalRuleEntry["kind"];
  source: GlobalRuleEntry["source"];
  createdAt: number;
  updatedAt: number;
};

function nextGlobalRuleSortOrder(db: SqliteDatabase): number {
  return (db.prepare(`
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextSortOrder
    FROM global_rules
  `).get() as { nextSortOrder: number }).nextSortOrder;
}

function insertGlobalRuleRow(db: SqliteDatabase, rule: GlobalRuleEntry, sortOrder: number): void {
  db.prepare(`
    INSERT INTO global_rules (
      id,
      title,
      content,
      kind,
      source,
      created_at_ms,
      updated_at_ms,
      sort_order
    )
    VALUES (
      @id,
      @title,
      @content,
      @kind,
      @source,
      @createdAt,
      @updatedAt,
      @sortOrder
    )
  `).run({ ...rule, sortOrder });
}

function globalRuleEntryInput(value: unknown): GlobalRuleEntry {
  return globalRuleEntrySchema.parse(value);
}
