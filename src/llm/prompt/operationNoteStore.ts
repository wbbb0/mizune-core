import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import type { Infer } from "#data/schema/types.ts";
import { s } from "#data/schema/index.ts";
import { rotateBackup } from "#utils/rotatingBackup.ts";

export const operationNoteSchema = s.object({
  id: s.string(),
  title: s.string(),
  content: s.string(),
  toolsetIds: s.array(s.string()).min(1),
  source: s.enum(["owner", "model"]).default("owner"),
  updatedAt: s.number().int().min(0).default(() => Date.now())
});

export type OperationNoteEntry = Infer<typeof operationNoteSchema>;

export const operationNoteFileSchema = s.array(operationNoteSchema).default([]);

function createOperationNoteEntry(input: {
  id?: string;
  title: string;
  content: string;
  toolsetIds: string[];
  source?: "owner" | "model";
}): OperationNoteEntry {
  return operationNoteSchema.parse({
    id: input.id ?? `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    title: input.title,
    content: input.content,
    toolsetIds: Array.from(new Set(input.toolsetIds.map((item) => item.trim()).filter(Boolean))),
    source: input.source ?? "owner",
    updatedAt: Date.now()
  });
}

export class OperationNoteStore {
  private readonly filePath: string;
  private readonly store: FileSchemaStore<typeof operationNoteFileSchema>;

  constructor(
    dataDir: string,
    private readonly config: Pick<AppConfig, "backup">,
    private readonly logger: Logger
  ) {
    this.filePath = join(dataDir, "operation-notes.json");
    this.store = new FileSchemaStore({
      filePath: this.filePath,
      schema: operationNoteFileSchema,
      logger,
      loadErrorEvent: "operation_note_store_load_failed"
    });
  }

  async init(): Promise<void> {
    await this.getAll();
  }

  async getAll(): Promise<OperationNoteEntry[]> {
    try {
      const parsed = await this.store.read();
      if (parsed) {
        return [...parsed];
      }
    } catch (error) {
      this.logger.warn({ error }, "operation_note_store_load_failed");
      throw error;
    }
    await this.writeAll([]);
    return [];
  }

  async upsert(input: {
    noteId?: string;
    title: string;
    content: string;
    toolsetIds: string[];
    source?: "owner" | "model";
  }): Promise<OperationNoteEntry[]> {
    const notes = await this.getAll();
    const next = createOperationNoteEntry({
      ...(input.noteId ? { id: input.noteId } : {}),
      title: input.title,
      content: input.content,
      toolsetIds: input.toolsetIds,
      ...(input.source ? { source: input.source } : {})
    });
    const targetIndex = notes.findIndex((item) => item.id === next.id);
    if (targetIndex >= 0) {
      notes[targetIndex] = next;
    } else {
      notes.push(next);
    }
    await this.writeAll(notes);
    this.logger.info({ noteId: next.id }, "operation_note_upserted");
    return notes;
  }

  async remove(noteId: string): Promise<OperationNoteEntry[]> {
    const notes = await this.getAll();
    const nextNotes = notes.filter((item) => item.id !== noteId);
    if (nextNotes.length === notes.length) {
      return notes;
    }
    await this.writeAll(nextNotes);
    this.logger.info({ noteId }, "operation_note_removed");
    return nextNotes;
  }

  async overwrite(notes: Array<{
    id?: string;
    title: string;
    content: string;
    toolsetIds: string[];
    source?: "owner" | "model";
  }>): Promise<OperationNoteEntry[]> {
    const nextNotes = notes.map((item) => createOperationNoteEntry(item));
    await this.writeAll(nextNotes);
    this.logger.info({ noteCount: nextNotes.length }, "operation_notes_overwritten");
    return nextNotes;
  }

  private async writeAll(notes: OperationNoteEntry[]): Promise<void> {
    const validated = operationNoteFileSchema.parse(notes);
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
