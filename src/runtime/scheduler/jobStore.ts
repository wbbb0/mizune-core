import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ScheduledJob, ScheduledJobSchedule } from "./types.ts";
import type { SqliteDatabase } from "#data/sqlite/sqliteService.ts";
import { StateDatabase } from "#data/state/stateDatabase.ts";
import { scheduledJobRecordSchema } from "./jobSchema.ts";

export class ScheduledJobStore {
  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly stateDatabase = new StateDatabase(dataDir, logger)
  ) {
  }

  async init(): Promise<void> {
    await this.stateDatabase.init();
  }

  async load(): Promise<ScheduledJob[]> {
    try {
      await this.stateDatabase.init();
      const rows = this.stateDatabase.getDb().prepare(`
        SELECT
          id,
          name,
          enabled,
          created_at_ms AS createdAtMs,
          updated_at_ms AS updatedAtMs,
          schedule_json AS scheduleJson,
          instruction,
          targets_json AS targetsJson,
          state_json AS stateJson
        FROM scheduled_jobs
        ORDER BY sort_order ASC, id ASC
      `).all() as ScheduledJobRow[];
      return rows.map(toScheduledJob);
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
    await this.insertJob(created);
    return created;
  }

  async update(job: ScheduledJob): Promise<void> {
    await this.stateDatabase.init();
    updateJobRow(this.stateDatabase.getDb(), scheduledJobRecordSchema.parse(job), false);
  }

  async remove(jobId: string): Promise<boolean> {
    await this.stateDatabase.init();
    const result = this.stateDatabase.getDb().prepare(`
      DELETE FROM scheduled_jobs
      WHERE id = ?
    `).run(jobId);
    return result.changes > 0;
  }

  async listRows(input: { offset?: number; limit?: number } = {}): Promise<{
    rows: ScheduledJob[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    await this.stateDatabase.init();
    const total = (this.stateDatabase.getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM scheduled_jobs
    `).get() as { count: number }).count;
    const rows = this.stateDatabase.getDb().prepare(`
      SELECT
        id,
        name,
        enabled,
        created_at_ms AS createdAtMs,
        updated_at_ms AS updatedAtMs,
        schedule_json AS scheduleJson,
        instruction,
        targets_json AS targetsJson,
        state_json AS stateJson
      FROM scheduled_jobs
      ORDER BY sort_order ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as ScheduledJobRow[];
    return {
      rows: rows.map(toScheduledJob),
      total,
      offset,
      limit
    };
  }

  async getRow(jobId: string): Promise<ScheduledJob | null> {
    await this.stateDatabase.init();
    const row = this.stateDatabase.getDb().prepare(`
      SELECT
        id,
        name,
        enabled,
        created_at_ms AS createdAtMs,
        updated_at_ms AS updatedAtMs,
        schedule_json AS scheduleJson,
        instruction,
        targets_json AS targetsJson,
        state_json AS stateJson
      FROM scheduled_jobs
      WHERE id = ?
    `).get(jobId) as ScheduledJobRow | undefined;
    return row ? toScheduledJob(row) : null;
  }

  async createRow(value: unknown): Promise<ScheduledJob> {
    const parsed = scheduledJobRecordSchema.parse({
      ...(value && typeof value === "object" ? value : {}),
      id: (value as { id?: unknown } | null)?.id ?? randomUUID(),
      createdAtMs: (value as { createdAtMs?: unknown } | null)?.createdAtMs ?? Date.now(),
      updatedAtMs: (value as { updatedAtMs?: unknown } | null)?.updatedAtMs ?? Date.now()
    });
    await this.insertJob(parsed);
    return parsed;
  }

  async patchRow(jobId: string, patch: Record<string, unknown>): Promise<ScheduledJob> {
    await this.stateDatabase.init();
    return this.stateDatabase.getDb().transaction(() => {
      const current = this.getRowSync(jobId);
      if (!current) {
        throw new Error(`Scheduled job ${jobId} not found`);
      }
      const nextId = typeof patch.id === "string" ? patch.id : jobId;
      if (nextId !== jobId) {
        throw new Error("Scheduled job id cannot be changed");
      }
      const parsed = scheduledJobRecordSchema.parse({
        ...current,
        ...patch,
        id: jobId
      });
      updateJobRow(this.stateDatabase.getDb(), parsed, true);
      return parsed;
    })();
  }

  async deleteRow(jobId: string): Promise<void> {
    await this.remove(jobId);
  }

  private async insertJob(job: ScheduledJob): Promise<void> {
    const parsed = scheduledJobRecordSchema.parse(job);
    await this.stateDatabase.init();
    try {
      this.stateDatabase.getDb().transaction((next: ScheduledJob) => {
        insertJobRow(this.stateDatabase.getDb(), next, nextJobSortOrder(this.stateDatabase.getDb()));
      })(parsed);
    } catch (error: unknown) {
      if (isSqliteConstraintError(error)) {
        throw new Error(`Scheduled job ${parsed.id} already exists`);
      }
      throw error;
    }
  }

  private getRowSync(jobId: string): ScheduledJob | null {
    const row = this.stateDatabase.getDb().prepare(`
      SELECT
        id,
        name,
        enabled,
        created_at_ms AS createdAtMs,
        updated_at_ms AS updatedAtMs,
        schedule_json AS scheduleJson,
        instruction,
        targets_json AS targetsJson,
        state_json AS stateJson
      FROM scheduled_jobs
      WHERE id = ?
    `).get(jobId) as ScheduledJobRow | undefined;
    return row ? toScheduledJob(row) : null;
  }
}

type ScheduledJobRow = {
  id: string;
  name: string;
  enabled: 0 | 1;
  createdAtMs: number;
  updatedAtMs: number;
  scheduleJson: string;
  instruction: string;
  targetsJson: string;
  stateJson: string;
};

function toScheduledJob(row: ScheduledJobRow): ScheduledJob {
  return scheduledJobRecordSchema.parse({
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    schedule: JSON.parse(row.scheduleJson),
    instruction: row.instruction,
    targets: JSON.parse(row.targetsJson),
    state: JSON.parse(row.stateJson)
  });
}

function toJobParams(job: ScheduledJob): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled ? 1 : 0,
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
    scheduleJson: JSON.stringify(job.schedule),
    instruction: job.instruction,
    targetsJson: JSON.stringify(job.targets),
    stateJson: JSON.stringify(job.state)
  };
}

function nextJobSortOrder(db: SqliteDatabase): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextSortOrder
    FROM scheduled_jobs
  `).get() as { nextSortOrder: number };
  return row.nextSortOrder;
}

function insertJobRow(db: SqliteDatabase, job: ScheduledJob, sortOrder: number): void {
  db.prepare(`
    INSERT INTO scheduled_jobs (
      id,
      name,
      enabled,
      created_at_ms,
      updated_at_ms,
      schedule_json,
      instruction,
      targets_json,
      state_json,
      sort_order
    )
    VALUES (
      @id,
      @name,
      @enabled,
      @createdAtMs,
      @updatedAtMs,
      @scheduleJson,
      @instruction,
      @targetsJson,
      @stateJson,
      @sortOrder
    )
  `).run({
    ...toJobParams(job),
    sortOrder
  });
}

function updateJobRow(db: SqliteDatabase, job: ScheduledJob, requireExisting: boolean): void {
  const result = db.prepare(`
    UPDATE scheduled_jobs
    SET
      name = @name,
      enabled = @enabled,
      created_at_ms = @createdAtMs,
      updated_at_ms = @updatedAtMs,
      schedule_json = @scheduleJson,
      instruction = @instruction,
      targets_json = @targetsJson,
      state_json = @stateJson
    WHERE id = @id
  `).run(toJobParams(job));
  if (requireExisting && result.changes === 0) {
    throw new Error(`Scheduled job ${job.id} not found`);
  }
}

function isSqliteConstraintError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && String((error as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT");
}
