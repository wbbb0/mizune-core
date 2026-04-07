import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ScheduledJob, ScheduledJobSchedule } from "./types.ts";
import { FileSchemaStore } from "#data/fileSchemaStore.ts";
import { scheduledJobFileSchema } from "./jobSchema.ts";

export class ScheduledJobStore {
  private readonly store: FileSchemaStore<typeof scheduledJobFileSchema>;

  constructor(
    dataDir: string,
    private readonly logger: Logger
  ) {
    this.store = new FileSchemaStore({
      filePath: join(dataDir, "scheduled-jobs.json"),
      schema: scheduledJobFileSchema,
      logger,
      loadErrorEvent: "scheduled_job_load_failed",
      atomicWrite: true
    });
  }

  async init(): Promise<void> {
    const current = await this.load();
    if (current.length === 0) {
      await this.write([]);
    }
  }

  async load(): Promise<ScheduledJob[]> {
    try {
      const payload = await this.store.readOrDefault({
        version: 1,
        jobs: []
      });
      return payload.jobs;
    } catch (error: unknown) {
      this.logger.warn({ error }, "scheduled_job_load_failed");
      return [];
    }
  }

  async list(): Promise<ScheduledJob[]> {
    return this.load();
  }

  async create(input: {
    name: string;
    schedule: ScheduledJobSchedule;
    instruction: string;
    targets: Array<{ sessionId: string }>;
  }): Promise<ScheduledJob> {
    const jobs = await this.load();
    const now = Date.now();
    const created: ScheduledJob = {
      id: randomUUID(),
      name: input.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: input.schedule,
      instruction: input.instruction,
      targets: input.targets,
      state: {
        nextRunAtMs: null,
        lastRunAtMs: null,
        lastRunStatus: null,
        lastDurationMs: null,
        lastError: null,
        consecutiveErrors: 0
      }
    };
    jobs.push(created);
    await this.write(jobs);
    return created;
  }

  async update(job: ScheduledJob): Promise<void> {
    const jobs = await this.load();
    const next = jobs.map((item) => item.id === job.id ? job : item);
    await this.write(next);
  }

  async remove(jobId: string): Promise<boolean> {
    const jobs = await this.load();
    const next = jobs.filter((item) => item.id !== jobId);
    if (next.length === jobs.length) {
      return false;
    }
    await this.write(next);
    return true;
  }

  private async write(jobs: ScheduledJob[]): Promise<void> {
    await this.store.write({
      version: 1,
      jobs: jobs.map((job) => ({
        id: job.id,
        name: job.name,
        enabled: job.enabled,
        createdAtMs: job.createdAtMs,
        updatedAtMs: job.updatedAtMs,
        schedule: job.schedule,
        instruction: job.instruction,
        targets: job.targets,
        state: job.state
      }))
    });
  }
}
