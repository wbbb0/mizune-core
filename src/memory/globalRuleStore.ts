import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";
import { detectScopeConflict, type ScopeConflictWarning } from "./memoryCategory.ts";
import { createGlobalRuleEntry, globalRuleFileSchema, type GlobalRuleEntry } from "./globalRuleEntry.ts";
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
  private readonly filePath: string;
  private readonly store: FileSchemaStore<typeof globalRuleFileSchema>;

  constructor(
    dataDir: string,
    private readonly config: Pick<AppConfig, "backup">,
    private readonly logger: Logger
  ) {
    this.filePath = join(dataDir, "global-rules.json");
    this.store = new FileSchemaStore({
      filePath: this.filePath,
      schema: globalRuleFileSchema,
      logger,
      loadErrorEvent: "global_rule_store_load_failed"
    });
  }

  async init(): Promise<void> {
    await this.readAll();
  }

  async list(): Promise<GlobalRuleEntry[]> {
    return this.readAll();
  }

  async getAll(): Promise<GlobalRuleEntry[]> {
    return this.readAll();
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
      rerouteReason: diagnostics.reroute.reason
    }, "global_rule_upserted");
    if (warning) {
      this.logger.warn({
        targetCategory: "global_rules",
        ruleId: nextRule.id,
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

  async remove(ruleId: string): Promise<GlobalRuleEntry[]> {
    const rules = await this.readAll();
    const nextRules = rules.filter((item) => item.id !== ruleId);
    if (nextRules.length === rules.length) {
      return rules;
    }
    await this.writeAll(nextRules);
    this.logger.info({ ruleId }, "global_rule_removed");
    return nextRules;
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
      const parsed = await this.store.read();
      if (parsed) {
        return [...parsed];
      }
    } catch (error) {
      this.logger.warn({ error }, "global_rule_store_load_failed");
      throw error;
    }
    await this.writeAll([]);
    return [];
  }

  private async writeAll(rules: GlobalRuleEntry[]): Promise<void> {
    const validated = globalRuleFileSchema.parse(rules);
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
