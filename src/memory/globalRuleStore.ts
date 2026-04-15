import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { readStructuredFileRaw } from "#data/schema/file.ts";
import { s } from "#data/schema/index.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";
import { memoryEntrySchema } from "./memoryEntry.ts";
import { createGlobalRuleEntry, globalRuleEntrySchema, type GlobalRuleEntry } from "./globalRuleEntry.ts";
import { findBestDuplicateMatch, normalizeTitleForDedup } from "./similarity.ts";

const globalRuleStoreSchema = s.array(globalRuleEntrySchema).default([]);
const legacyGlobalMemoryFileSchema = s.array(memoryEntrySchema).default([]);

export interface GlobalRuleUpsertResult {
  action: "created" | "updated_existing";
  item: GlobalRuleEntry;
  rules: GlobalRuleEntry[];
}

export class GlobalRuleStore {
  private readonly filePath: string;
  private readonly legacyFilePath: string;
  private readonly store: FileSchemaStore<typeof globalRuleStoreSchema>;

  constructor(
    dataDir: string,
    private readonly config: Pick<AppConfig, "backup">,
    private readonly logger: Logger
  ) {
    this.filePath = join(dataDir, "global-rules.json");
    this.legacyFilePath = join(dataDir, "global-memories.json");
    this.store = new FileSchemaStore({
      filePath: this.filePath,
      schema: globalRuleStoreSchema,
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
    const targetId = input.ruleId || duplicate?.id;
    const action = targetId ? "updated_existing" as const : "created" as const;
    const nextRule = createGlobalRuleEntry({
      ...(targetId ? { id: targetId } : {}),
      title: input.title,
      content: input.content,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
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
    this.logger.info({ ruleId: nextRule.id, action }, "global_rule_upserted");
    return { action, item: nextRule, rules };
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

    const migrated = await this.migrateLegacyFile();
    if (migrated) {
      return migrated;
    }
    await this.writeAll([]);
    return [];
  }

  private async migrateLegacyFile(): Promise<GlobalRuleEntry[] | null> {
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
    const legacyEntries = legacyGlobalMemoryFileSchema.parse(raw);
    const migrated = legacyEntries.map((item) => createGlobalRuleEntry({
      id: item.id,
      title: item.title,
      content: item.content,
      createdAt: item.updatedAt,
      updatedAt: item.updatedAt,
      source: "owner_explicit"
    }));
    await this.writeAll(migrated);
    this.logger.info({ count: migrated.length, legacyFilePath: this.legacyFilePath }, "global_rule_store_migrated_legacy_file");
    return migrated;
  }

  private async writeAll(rules: GlobalRuleEntry[]): Promise<void> {
    const validated = globalRuleStoreSchema.parse(rules);
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
