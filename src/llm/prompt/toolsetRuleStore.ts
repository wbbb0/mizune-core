import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import type { Infer } from "#data/schema/types.ts";
import { s } from "#data/schema/index.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";
import { detectScopeConflict, type ScopeConflictWarning } from "#memory/memoryCategory.ts";
import { findBestDuplicateMatch, normalizeTextForSimilarity, normalizeTitleForDedup } from "#memory/similarity.ts";
import {
  buildMemoryDedupDetails,
  buildMemoryWriteDiagnostics,
  type MemoryDedupDetails,
  type MemoryWriteAction
} from "#memory/writeResult.ts";

export const toolsetRuleSchema = s.object({
  id: s.string().trim().nonempty(),
  title: s.string().trim().nonempty(),
  content: s.string().trim().nonempty(),
  toolsetIds: s.array(s.string().trim().nonempty()).min(1),
  fingerprint: s.string().trim().nonempty(),
  source: s.enum(["owner_explicit", "inferred"] as const).default("owner_explicit"),
  createdAt: s.number().int().min(0).default(() => Date.now()),
  updatedAt: s.number().int().min(0).default(() => Date.now())
}).strict();

export type ToolsetRuleEntry = Infer<typeof toolsetRuleSchema>;
export const toolsetRuleFileSchema = s.array(toolsetRuleSchema).default([]);

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
  private readonly filePath: string;
  private readonly store: FileSchemaStore<typeof toolsetRuleFileSchema>;

  constructor(
    dataDir: string,
    private readonly config: Pick<AppConfig, "backup">,
    private readonly logger: Logger
  ) {
    this.filePath = join(dataDir, "toolset-rules.json");
    this.store = new FileSchemaStore({
      filePath: this.filePath,
      schema: toolsetRuleFileSchema,
      logger,
      loadErrorEvent: "toolset_rule_store_load_failed"
    });
  }

  async init(): Promise<void> {
    await this.getAll();
  }

  async getAll(): Promise<ToolsetRuleEntry[]> {
    try {
      const parsed = await this.store.read();
      if (parsed) {
        return [...parsed];
      }
    } catch (error) {
      this.logger.warn({ error }, "toolset_rule_store_load_failed");
      throw error;
    }
    await this.writeAll([]);
    return [];
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
    if (targetIndex >= 0) {
      rules[targetIndex] = { ...nextRule, createdAt: rules[targetIndex]!.createdAt };
    } else {
      rules.push(nextRule);
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
    await this.writeAll(rules);
    this.logger.info({
      targetCategory: diagnostics.targetCategory,
      ruleId: nextRule.id,
      action: diagnostics.action,
      finalAction: diagnostics.finalAction,
      dedupMatchedBy: diagnostics.dedup.matchedBy,
      dedupMatchedExistingId: diagnostics.dedup.matchedExistingId,
      dedupSimilarityScore: diagnostics.dedup.similarityScore,
      rerouteResult: diagnostics.reroute.result,
      rerouteSuggestedScope: diagnostics.reroute.suggestedScope,
      rerouteReason: diagnostics.reroute.reason,
      toolsetIds: nextRule.toolsetIds
    }, "toolset_rule_upserted");
    if (warning) {
      this.logger.warn({
        targetCategory: "toolset_rules",
        ruleId: nextRule.id,
        toolsetIds: nextRule.toolsetIds,
        suggestedScope: warning.suggestedScope,
        reason: warning.reason
      }, "memory_scope_conflict_detected");
    }
    return {
      action,
      finalAction: diagnostics.finalAction,
      dedup,
      warning,
      item: nextRule,
      rules
    };
  }

  async remove(ruleId: string): Promise<ToolsetRuleEntry[]> {
    const rules = await this.getAll();
    const nextRules = rules.filter((item) => item.id !== ruleId);
    if (nextRules.length === rules.length) {
      return rules;
    }
    await this.writeAll(nextRules);
    this.logger.info({ ruleId }, "toolset_rule_removed");
    return nextRules;
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
    await this.createBackupIfNeeded();
    await this.store.write(validated);
  }

  private async createBackupIfNeeded(): Promise<void> {
    try {
      await stat(this.filePath);
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return;
      }
      throw error;
    }

    await rotateBackup({
      sourceFilePath: this.filePath,
      limit: this.config.backup.profileRotateLimit,
      logger: this.logger
    });
  }
}
