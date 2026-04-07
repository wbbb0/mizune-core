import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { comfyTaskFileSchema, type ComfyTaskRecord } from "./taskSchema.ts";

export class ComfyTaskStore {
  private readonly store: FileSchemaStore<typeof comfyTaskFileSchema>;

  constructor(
    dataDir: string,
    private readonly logger: Logger
  ) {
    this.store = new FileSchemaStore({
      filePath: join(dataDir, "comfy", "tasks.json"),
      schema: comfyTaskFileSchema,
      logger,
      loadErrorEvent: "comfy_task_load_failed",
      atomicWrite: true
    });
  }

  async init(): Promise<void> {
    await this.store.readOrDefault({
      version: 1,
      tasks: []
    });
  }

  async list(): Promise<ComfyTaskRecord[]> {
    const payload = await this.store.readOrDefault({
      version: 1,
      tasks: []
    });
    return payload.tasks;
  }

  async getById(taskId: string): Promise<ComfyTaskRecord | null> {
    const tasks = await this.list();
    return tasks.find((item) => item.id === taskId) ?? null;
  }

  async listActive(): Promise<ComfyTaskRecord[]> {
    const tasks = await this.list();
    return tasks.filter((item) => item.status === "queued" || item.status === "running");
  }

  async create(input: Omit<ComfyTaskRecord, "id" | "createdAtMs" | "updatedAtMs">): Promise<ComfyTaskRecord> {
    const now = Date.now();
    const created: ComfyTaskRecord = {
      ...input,
      id: randomUUID(),
      createdAtMs: now,
      updatedAtMs: now
    };
    const tasks = await this.list();
    tasks.push(created);
    await this.write(tasks);
    return created;
  }

  async update(task: ComfyTaskRecord): Promise<void> {
    const tasks = await this.list();
    await this.write(tasks.map((item) => item.id === task.id ? {
      ...task,
      updatedAtMs: Date.now()
    } : item));
  }

  async updateById(
    taskId: string,
    updater: (task: ComfyTaskRecord) => ComfyTaskRecord
  ): Promise<ComfyTaskRecord | null> {
    const tasks = await this.list();
    let updated: ComfyTaskRecord | null = null;
    const next = tasks.map((item) => {
      if (item.id !== taskId) {
        return item;
      }
      updated = {
        ...updater(item),
        updatedAtMs: Date.now()
      };
      return updated;
    });
    if (!updated) {
      return null;
    }
    await this.write(next);
    return updated;
  }

  private async write(tasks: ComfyTaskRecord[]): Promise<void> {
    await this.store.write({
      version: 1,
      tasks
    });
  }
}
