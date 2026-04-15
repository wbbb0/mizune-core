import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { readStructuredFileRaw } from "#data/schema/file.ts";
import type { Infer } from "#data/schema/types.ts";
import { s } from "#data/schema/index.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";
import { findBestDuplicateMatch, normalizeTitleForDedup } from "#memory/similarity.ts";

export const toolsetRuleSchema = s.object({
  id: s.string().trim().nonempty(),
  title: s.string().trim().nonempty(),
  content: s.string().trim().nonempty(),
  toolsetIds: s.array(s.string().trim().nonempty()).min(1),
  source: s.enum(["owner_explicit", "inferred"] as const).default("owner_explicit"),
  createdAt: s.number().int().min(0).default(() => Date.now()),
  updatedAt: s.number().int().min(0).default(() => Date.now())
}).strict();

export type ToolsetRuleEntry = Infer<typeof toolsetRuleSchema>;
export const toolsetRuleFileSchema = s.array(toolsetRuleSchema).default([]);

const legacyOperationNoteSchema = s.object({
  id: s.string(),
  title: s.string(),
  content: s.string(),
  toolsetIds: s.array(s.string()).min(1),
  source: s.enum(["owner", "model"]).default("owner"),
  updatedAt: s.number().int().min(0)
}).strict();

const legacyOperationNoteFileSchema = s.array(legacyOperationNoteSchema).default([]);

export interface ToolsetRuleUpsertResult {
  action: "created" | "updated_existing";
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
  return toolsetRuleSchema.parse({
    id: input.id ?? `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    title: input.title.trim(),
    content: input.content.trim(),
    toolsetIds: Array.from(new Set(input.toolsetIds.map((item) => item.trim()).filter(Boolean))),
    source: input.source ?? "owner_explicit",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  });
}

function haveOverlappingToolsets(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

export class ToolsetRuleStore {
  private readonly filePath: string;
  private readonly legacyFilePath: string;
  private readonly store: FileSchemaStore<typeof toolsetRuleFileSchema>;

  constructor(
    dataDir: string,
    private readonly config: Pick<AppConfig, "backup">,
    private readonly logger: Logger
  ) {
    this.filePath = join(dataDir, "toolset-rules.json");
    this.legacyFilePath = join(dataDir, "operation-notes.json");
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

    const migrated = await this.migrateLegacyFile();
    if (migrated) {
      return migrated;
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
          `${normalizeTitleForDedup(input.title)} ${input.content}`,
          rules.filter((item) => haveOverlappingToolsets(item.toolsetIds, input.toolsetIds)),
          (item) => `${normalizeTitleForDedup(item.title)} ${item.content}`
        );
    const targetId = input.ruleId || duplicate?.id;
    const action = targetId ? "updated_existing" as const : "created" as const;
    const nextRule = createToolsetRuleEntry({
      ...(targetId ? { id: targetId } : {}),
      title: input.title,
      content: input.content,
      toolsetIds: input.toolsetIds,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(duplicate ? { createdAt: duplicate.createdAt } : {})
    });
    const targetIndex = rules.findIndex((item) => item.id === nextRule.id);
    if (targetIndex >= 0) {
      rules[targetIndex] = { ...nextRule, createdAt: rules[targetIndex]!.createdAt };
    } else {
      rules.push(nextRule);
    }
    await this.writeAll(rules);
    this.logger.info({ ruleId: nextRule.id, action }, "toolset_rule_upserted");
    return { action, item: nextRule, rules };
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

  private async migrateLegacyFile(): Promise<ToolsetRuleEntry[] | null> {
    let raw: unknown;
    try {
      raw = await readStructuredFileRaw(this.legacyFilePath);
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const legacyEntries = legacyOperationNoteFileSchema.parse(raw);
    const migrated = legacyEntries.map((item) => createToolsetRuleEntry({
      id: item.id,
      title: item.title,
      content: item.content,
      toolsetIds: item.toolsetIds,
      source: item.source === "owner" ? "owner_explicit" : "inferred",
      createdAt: item.updatedAt,
      updatedAt: item.updatedAt
    }));
    await this.writeAll(migrated);
    this.logger.info({ count: migrated.length, legacyFilePath: this.legacyFilePath }, "toolset_rule_store_migrated_legacy_file");
    return migrated;
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
