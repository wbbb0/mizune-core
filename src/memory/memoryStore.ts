import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";
import { createMemoryEntry, memoryEntrySchema, type MemoryEntry } from "./memoryEntry.ts";
import { s } from "#data/schema/index.ts";

const memoryStoreSchema = s.array(memoryEntrySchema).default([]);

export class GlobalMemoryStore {
  private readonly filePath: string;
  private readonly store: FileSchemaStore<typeof memoryStoreSchema>;

  constructor(
    dataDir: string,
    private readonly config: Pick<AppConfig, "backup">,
    private readonly logger: Logger
  ) {
    this.filePath = join(dataDir, "global-memories.json");
    this.store = new FileSchemaStore({
      filePath: this.filePath,
      schema: memoryStoreSchema,
      logger,
      loadErrorEvent: "global_memory_store_load_failed"
    });
  }

  async init(): Promise<void> {
    await this.readAll();
  }

  async list(): Promise<MemoryEntry[]> {
    return this.readAll();
  }

  async getAll(): Promise<MemoryEntry[]> {
    return this.readAll();
  }

  async upsert(input: {
    memoryId?: string;
    title: string;
    content: string;
  }): Promise<MemoryEntry[]> {
    const memories = await this.readAll();
    const nextMemory = createMemoryEntry({
      ...(input.memoryId ? { id: input.memoryId } : {}),
      title: input.title,
      content: input.content
    });
    const targetIndex = memories.findIndex((item) => item.id === nextMemory.id);
    if (targetIndex >= 0) {
      memories[targetIndex] = nextMemory;
    } else {
      memories.push(nextMemory);
    }
    await this.writeAll(memories);
    this.logger.info({ memoryId: nextMemory.id }, "global_memory_upserted");
    return memories;
  }

  async remove(memoryId: string): Promise<MemoryEntry[]> {
    const memories = await this.readAll();
    const nextMemories = memories.filter((item) => item.id !== memoryId);
    if (nextMemories.length === memories.length) {
      return memories;
    }
    await this.writeAll(nextMemories);
    this.logger.info({ memoryId }, "global_memory_removed");
    return nextMemories;
  }

  async overwrite(memories: Array<{ id?: string; title: string; content: string }>): Promise<MemoryEntry[]> {
    const nextMemories = memories.map((item) => createMemoryEntry(item));
    await this.writeAll(nextMemories);
    this.logger.info({ memoryCount: nextMemories.length }, "global_memories_overwritten");
    return nextMemories;
  }

  private async readAll(): Promise<MemoryEntry[]> {
    try {
      const parsed = await this.store.read();
      if (parsed) {
        return [...parsed];
      }
    } catch (error) {
      this.logger.warn({ error }, "global_memory_store_load_failed");
      throw error;
    }
    await this.writeAll([]);
    return [];
  }

  private async writeAll(memories: MemoryEntry[]): Promise<void> {
    const validated = memoryStoreSchema.parse(memories);
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
