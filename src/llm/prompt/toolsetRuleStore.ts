import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { SqliteDatabase } from "#data/sqlite/sqliteService.ts";
import { StateDatabase } from "#data/state/stateDatabase.ts";
import type { Infer } from "#data/schema/types.ts";
import { s } from "#data/schema/index.ts";
import { detectScopeConflict, type ScopeConflictWarning } from "#memory/memoryCategory.ts";
import { findBestDuplicateMatch, normalizeTextForSimilarity, normalizeTitleForDedup } from "#memory/similarity.ts";
import {
  buildMemoryDedupDetails,
  buildMemoryWriteDiagnostics,
  type MemoryDedupDetails,
  type MemoryWriteAction
} from "#memory/writeResult.ts";

export const toolsetRuleSchema = s.object({
  id: s.string().trim().nonempty().title("ID"),
  title: s.string().trim().nonempty().title("标题"),
  content: s.string().trim().nonempty().title("内容"),
  toolsetIds: s.array(s.string().trim().nonempty().title("工具集 ID"))
    .title("工具集")
    .min(1),
  fingerprint: s.string().trim().nonempty()
    .title("指纹")
    .describe("用于去重匹配的内部标识。编辑时可留空，由系统重新计算。")
    .default("__computed__"),
  source: s.enum(["owner_explicit", "inferred"] as const).title("来源").default("owner_explicit"),
  createdAt: s.number().int().min(0).title("创建时间").default(() => Date.now()),
  updatedAt: s.number().int().min(0).title("更新时间").default(() => Date.now())
}).title("工具集规则")
  .describe("定义只在指定工具集下生效的长期规则。")
  .strict();

export type ToolsetRuleEntry = Infer<typeof toolsetRuleSchema>;
export const toolsetRuleFileSchema = s.array(toolsetRuleSchema)
  .title("工具集规则列表")
  .describe("按列表保存仅对指定工具集生效的规则。")
  .default([]);

export interface ToolsetRuleUpsertResult {
  action: MemoryWriteAction;
  finalAction: "created" | "updated_existing" | "warning_scope_conflict";
  dedup: MemoryDedupDetails;
  warning: ScopeConflictWarning | null;
  item: ToolsetRuleEntry;
  rules: ToolsetRuleEntry[];
}

export function createToolsetRuleEntry(input: {
  id?: string;
  title: string;
  content: string;
  toolsetIds: string[];
  source?: ToolsetRuleEntry["source"];
  createdAt?: number;
  updatedAt?: number;
}): ToolsetRuleEntry {
  const now = Date.now();
  const normalizedToolsetIds = Array.from(new Set(input.toolsetIds.map((item) => item.trim()).filter(Boolean)));
  return toolsetRuleSchema.parse({
    id: input.id ?? `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    title: input.title.trim(),
    content: input.content.trim(),
    toolsetIds: normalizedToolsetIds,
    fingerprint: buildToolsetRuleFingerprint({
      title: input.title,
      content: input.content,
      toolsetIds: normalizedToolsetIds
    }),
    source: input.source ?? "owner_explicit",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  });
}

function buildToolsetRuleFingerprint(input: {
  title: string;
  content: string;
  toolsetIds: string[];
}): string {
  return [
    normalizeTitleForDedup(input.title),
    normalizeTextForSimilarity(input.content),
    input.toolsetIds.slice().sort().join("|")
  ].join("::");
}

function haveOverlappingToolsets(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

export class ToolsetRuleStore {
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

  async getAll(): Promise<ToolsetRuleEntry[]> {
    try {
      await this.stateDatabase.init();
      const rows = this.stateDatabase.getDb().prepare(`
        SELECT
          id,
          title,
          content,
          fingerprint,
          source,
          created_at_ms AS createdAt,
          updated_at_ms AS updatedAt
        FROM toolset_rules
        ORDER BY sort_order ASC, id ASC
      `).all() as ToolsetRuleRow[];
      const toolsetRows = this.stateDatabase.getDb().prepare(`
        SELECT rule_id AS ruleId, toolset_id AS toolsetId
        FROM toolset_rule_toolsets
        ORDER BY rule_id ASC, sort_order ASC, toolset_id ASC
      `).all() as ToolsetRuleToolsetRow[];
      const toolsetsByRuleId = new Map<string, string[]>();
      for (const row of toolsetRows) {
        const current = toolsetsByRuleId.get(row.ruleId) ?? [];
        current.push(row.toolsetId);
        toolsetsByRuleId.set(row.ruleId, current);
      }
      return toolsetRuleFileSchema.parse(rows.map((row) => createToolsetRuleEntry({
        ...row,
        toolsetIds: toolsetsByRuleId.get(row.id) ?? []
      })));
    } catch (error) {
      this.logger.warn({ error }, "toolset_rule_store_load_failed");
      throw error;
    }
  }

  async getRow(ruleId: string): Promise<ToolsetRuleEntry | null> {
    return (await this.getAll()).find((rule) => rule.id === ruleId) ?? null;
  }

  async createRow(value: unknown): Promise<ToolsetRuleEntry> {
    const parsed = createToolsetRuleEntry(toolsetRuleSchema.parse(value));
    if (await this.getRow(parsed.id)) {
      throw new Error(`Toolset rule ${parsed.id} already exists`);
    }
    await this.insertRule(parsed);
    return parsed;
  }

  async patchRow(ruleId: string, patch: Record<string, unknown>): Promise<ToolsetRuleEntry> {
    const current = await this.getRow(ruleId);
    if (!current) {
      throw new Error(`Toolset rule ${ruleId} not found`);
    }
    const parsed = createToolsetRuleEntry(toolsetRuleSchema.parse({ ...current, ...patch, id: ruleId }));
    await this.updateRule(parsed);
    return parsed;
  }

  async upsert(input: {
    ruleId?: string;
    title: string;
    content: string;
    toolsetIds: string[];
    source?: ToolsetRuleEntry["source"];
  }): Promise<ToolsetRuleUpsertResult> {
    const rules = await this.getAll();
    const duplicate = input.ruleId
      ? null
      : findBestDuplicateMatch(
          buildToolsetRuleFingerprint({
            title: input.title,
            content: input.content,
            toolsetIds: input.toolsetIds
          }),
          rules.filter((item) => haveOverlappingToolsets(item.toolsetIds, input.toolsetIds)),
          (item) => item.fingerprint
        );
    const targetId = input.ruleId || duplicate?.item.id;
    const action = targetId && rules.some((item) => item.id === targetId)
      ? "updated_existing" as const
      : "created" as const;
    const nextRule = createToolsetRuleEntry({
      ...(targetId ? { id: targetId } : {}),
      title: input.title,
      content: input.content,
      toolsetIds: input.toolsetIds,
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
      currentScope: "toolset_rules",
      title: input.title,
      content: input.content
    });
    const diagnostics = buildMemoryWriteDiagnostics({
      targetCategory: "toolset_rules",
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
      rerouteReason: diagnostics.reroute.reason,
      toolsetIds: item.toolsetIds
    }, "toolset_rule_upserted");
    if (warning) {
      this.logger.warn({
        targetCategory: "toolset_rules",
        ruleId: item.id,
        toolsetIds: item.toolsetIds,
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
      rules: await this.getAll()
    };
  }

  async remove(ruleId: string): Promise<ToolsetRuleEntry[]> {
    const rules = await this.getAll();
    const exists = rules.some((item) => item.id === ruleId);
    if (!exists) {
      return rules;
    }
    await this.stateDatabase.init();
    this.stateDatabase.getDb().prepare(`
      DELETE FROM toolset_rules
      WHERE id = ?
    `).run(ruleId);
    this.logger.info({ ruleId }, "toolset_rule_removed");
    return this.getAll();
  }

  async overwrite(rules: Array<{
    id?: string;
    title: string;
    content: string;
    toolsetIds: string[];
    source?: ToolsetRuleEntry["source"];
    createdAt?: number;
    updatedAt?: number;
  }>): Promise<ToolsetRuleEntry[]> {
    const nextRules = rules.map((item) => createToolsetRuleEntry(item));
    await this.writeAll(nextRules);
    this.logger.info({ ruleCount: nextRules.length }, "toolset_rules_overwritten");
    return nextRules;
  }

  private async writeAll(rules: ToolsetRuleEntry[]): Promise<void> {
    const validated = toolsetRuleFileSchema.parse(rules);
    await this.stateDatabase.init();
    this.stateDatabase.getDb().transaction((nextRules: ToolsetRuleEntry[]) => {
      const db = this.stateDatabase.getDb();
      db.prepare("DELETE FROM toolset_rule_toolsets").run();
      db.prepare("DELETE FROM toolset_rules").run();
      nextRules.forEach((rule, index) => insertToolsetRuleRow(db, rule, index + 1));
    })(validated);
  }

  private async insertRule(rule: ToolsetRuleEntry): Promise<void> {
    await this.stateDatabase.init();
    insertToolsetRuleRow(this.stateDatabase.getDb(), rule, nextToolsetRuleSortOrder(this.stateDatabase.getDb()));
  }

  private async updateRule(rule: ToolsetRuleEntry): Promise<void> {
    await this.stateDatabase.init();
    this.stateDatabase.getDb().transaction((next: ToolsetRuleEntry) => {
      const db = this.stateDatabase.getDb();
      db.prepare(`
        UPDATE toolset_rules
        SET
          title = @title,
          content = @content,
          fingerprint = @fingerprint,
          source = @source,
          created_at_ms = @createdAt,
          updated_at_ms = @updatedAt
        WHERE id = @id
      `).run(next);
      db.prepare("DELETE FROM toolset_rule_toolsets WHERE rule_id = ?").run(next.id);
      insertToolsetRuleToolsetRows(db, next);
    })(rule);
  }
}

type ToolsetRuleRow = {
  id: string;
  title: string;
  content: string;
  fingerprint: string;
  source: ToolsetRuleEntry["source"];
  createdAt: number;
  updatedAt: number;
};

type ToolsetRuleToolsetRow = {
  ruleId: string;
  toolsetId: string;
};

function nextToolsetRuleSortOrder(db: SqliteDatabase): number {
  return (db.prepare(`
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextSortOrder
    FROM toolset_rules
  `).get() as { nextSortOrder: number }).nextSortOrder;
}

function insertToolsetRuleRow(db: SqliteDatabase, rule: ToolsetRuleEntry, sortOrder: number): void {
  db.prepare(`
    INSERT INTO toolset_rules (
      id,
      title,
      content,
      fingerprint,
      source,
      created_at_ms,
      updated_at_ms,
      sort_order
    )
    VALUES (
      @id,
      @title,
      @content,
      @fingerprint,
      @source,
      @createdAt,
      @updatedAt,
      @sortOrder
    )
  `).run({ ...rule, sortOrder });
  insertToolsetRuleToolsetRows(db, rule);
}

function insertToolsetRuleToolsetRows(db: SqliteDatabase, rule: ToolsetRuleEntry): void {
  const insert = db.prepare(`
    INSERT INTO toolset_rule_toolsets (
      rule_id,
      toolset_id,
      sort_order
    )
    VALUES (?, ?, ?)
  `);
  rule.toolsetIds.forEach((toolsetId, index) => {
    insert.run(rule.id, toolsetId, index + 1);
  });
}
