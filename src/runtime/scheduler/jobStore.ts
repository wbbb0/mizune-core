import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ScheduledJob, ScheduledJobSchedule, ScheduledJobTarget } from "./types.ts";
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
        ${SCHEDULED_JOB_SELECT}
      FROM scheduled_jobs
      ORDER BY sort_order ASC, id ASC
    `).all() as ScheduledJobRow[];
      const targets = listTargetsForJobs(this.stateDatabase.getDb(), rows.map((row) => row.id));
      return rows.map((row) => toScheduledJob(row, targets.get(row.id) ?? []));
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
    this.stateDatabase.getDb().transaction((next: ScheduledJob) => {
      updateJobRow(this.stateDatabase.getDb(), next, false);
    })(scheduledJobRecordSchema.parse(job));
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
      ${SCHEDULED_JOB_SELECT}
      FROM scheduled_jobs
      ORDER BY sort_order ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as ScheduledJobRow[];
    const targets = listTargetsForJobs(this.stateDatabase.getDb(), rows.map((row) => row.id));
    return {
      rows: rows.map((row) => toScheduledJob(row, targets.get(row.id) ?? [])),
      total,
      offset,
      limit
    };
  }

  async listTargetRows(input: { offset?: number; limit?: number; filters?: Record<string, unknown> } = {}): Promise<{
    rows: Array<{ jobId: string; sessionId: string; sortOrder: number }>;
    total: number;
    offset: number;
    limit: number;
  }> {
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
    const jobId = typeof input.filters?.jobId === "string" && input.filters.jobId.trim()
      ? input.filters.jobId.trim()
      : null;
    const whereSql = jobId ? "WHERE job_id = ?" : "";
    const params = jobId ? [jobId] : [];
    await this.stateDatabase.init();
    const total = (this.stateDatabase.getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM scheduled_job_targets
      ${whereSql}
    `).get(...params) as { count: number }).count;
    const rows = this.stateDatabase.getDb().prepare(`
      SELECT
        job_id AS jobId,
        session_id AS sessionId,
        sort_order AS sortOrder
      FROM scheduled_job_targets
      ${whereSql}
      ORDER BY job_id ASC, sort_order ASC, session_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{ jobId: string; sessionId: string; sortOrder: number }>;
    return { rows, total, offset, limit };
  }

  async getRow(jobId: string): Promise<ScheduledJob | null> {
    await this.stateDatabase.init();
    const row = this.stateDatabase.getDb().prepare(`
      ${SCHEDULED_JOB_SELECT}
      FROM scheduled_jobs
      WHERE id = ?
    `).get(jobId) as ScheduledJobRow | undefined;
    return row ? toScheduledJob(row, listTargetsForJob(this.stateDatabase.getDb(), row.id)) : null;
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
      ${SCHEDULED_JOB_SELECT}
      FROM scheduled_jobs
      WHERE id = ?
    `).get(jobId) as ScheduledJobRow | undefined;
    return row ? toScheduledJob(row, listTargetsForJob(this.stateDatabase.getDb(), row.id)) : null;
  }
}

const SCHEDULED_JOB_SELECT = `
      SELECT
        id,
        name,
        enabled,
        created_at_ms AS createdAtMs,
        updated_at_ms AS updatedAtMs,
        schedule_kind AS scheduleKind,
        schedule_delay_ms AS scheduleDelayMs,
        schedule_run_at_ms AS scheduleRunAtMs,
        schedule_cron_expr AS scheduleCronExpr,
        schedule_timezone AS scheduleTimezone,
        instruction,
        next_run_at_ms AS nextRunAtMs,
        last_run_at_ms AS lastRunAtMs,
        last_run_status AS lastRunStatus,
        last_duration_ms AS lastDurationMs,
        last_error AS lastError,
        consecutive_errors AS consecutiveErrors
`;

type ScheduledJobRow = {
  id: string;
  name: string;
  enabled: 0 | 1;
  createdAtMs: number;
  updatedAtMs: number;
  scheduleKind: ScheduledJobSchedule["kind"];
  scheduleDelayMs: number | null;
  scheduleRunAtMs: number | null;
  scheduleCronExpr: string | null;
  scheduleTimezone: string | null;
  instruction: string;
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastRunStatus: ScheduledJob["state"]["lastRunStatus"];
  lastDurationMs: number | null;
  lastError: string | null;
  consecutiveErrors: number;
};

type ScheduledJobTargetRow = {
  job_id: string;
  session_id: string;
};

function toScheduledJob(row: ScheduledJobRow, targets: ScheduledJobTarget[]): ScheduledJob {
  return scheduledJobRecordSchema.parse({
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    schedule: rowToSchedule(row),
    instruction: row.instruction,
    targets,
    state: {
      nextRunAtMs: row.nextRunAtMs,
      lastRunAtMs: row.lastRunAtMs,
      lastRunStatus: row.lastRunStatus,
      lastDurationMs: row.lastDurationMs,
      lastError: row.lastError,
      consecutiveErrors: row.consecutiveErrors
    }
  });
}

function rowToSchedule(row: ScheduledJobRow): ScheduledJobSchedule {
  if (row.scheduleKind === "delay") {
    return { kind: "delay", delayMs: row.scheduleDelayMs ?? 0 };
  }
  if (row.scheduleKind === "at") {
    return {
      kind: "at",
      runAtMs: row.scheduleRunAtMs ?? 0,
      tz: row.scheduleTimezone ?? "UTC"
    };
  }
  return {
    kind: "cron",
    expr: row.scheduleCronExpr ?? "",
    tz: row.scheduleTimezone ?? "UTC"
  };
}

function toJobParams(job: ScheduledJob): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled ? 1 : 0,
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
    scheduleKind: job.schedule.kind,
    scheduleDelayMs: job.schedule.kind === "delay" ? job.schedule.delayMs : null,
    scheduleRunAtMs: job.schedule.kind === "at" ? job.schedule.runAtMs : null,
    scheduleCronExpr: job.schedule.kind === "cron" ? job.schedule.expr : null,
    scheduleTimezone: job.schedule.kind === "delay" ? null : job.schedule.tz,
    instruction: job.instruction,
    nextRunAtMs: job.state.nextRunAtMs,
    lastRunAtMs: job.state.lastRunAtMs,
    lastRunStatus: job.state.lastRunStatus,
    lastDurationMs: job.state.lastDurationMs,
    lastError: job.state.lastError,
    consecutiveErrors: job.state.consecutiveErrors
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
      schedule_kind,
      schedule_delay_ms,
      schedule_run_at_ms,
      schedule_cron_expr,
      schedule_timezone,
      instruction,
      next_run_at_ms,
      last_run_at_ms,
      last_run_status,
      last_duration_ms,
      last_error,
      consecutive_errors,
      sort_order
    )
    VALUES (
      @id,
      @name,
      @enabled,
      @createdAtMs,
      @updatedAtMs,
      @scheduleKind,
      @scheduleDelayMs,
      @scheduleRunAtMs,
      @scheduleCronExpr,
      @scheduleTimezone,
      @instruction,
      @nextRunAtMs,
      @lastRunAtMs,
      @lastRunStatus,
      @lastDurationMs,
      @lastError,
      @consecutiveErrors,
      @sortOrder
    )
  `).run({
    ...toJobParams(job),
    sortOrder
  });
  replaceJobTargets(db, job);
}

function updateJobRow(db: SqliteDatabase, job: ScheduledJob, requireExisting: boolean): void {
  const result = db.prepare(`
    UPDATE scheduled_jobs
    SET
      name = @name,
      enabled = @enabled,
      created_at_ms = @createdAtMs,
      updated_at_ms = @updatedAtMs,
      schedule_kind = @scheduleKind,
      schedule_delay_ms = @scheduleDelayMs,
      schedule_run_at_ms = @scheduleRunAtMs,
      schedule_cron_expr = @scheduleCronExpr,
      schedule_timezone = @scheduleTimezone,
      instruction = @instruction,
      next_run_at_ms = @nextRunAtMs,
      last_run_at_ms = @lastRunAtMs,
      last_run_status = @lastRunStatus,
      last_duration_ms = @lastDurationMs,
      last_error = @lastError,
      consecutive_errors = @consecutiveErrors
    WHERE id = @id
  `).run(toJobParams(job));
  if (requireExisting && result.changes === 0) {
    throw new Error(`Scheduled job ${job.id} not found`);
  }
  if (result.changes > 0) {
    replaceJobTargets(db, job);
  }
}

function replaceJobTargets(db: SqliteDatabase, job: ScheduledJob): void {
  db.prepare(`DELETE FROM scheduled_job_targets WHERE job_id = ?`).run(job.id);
  const insertTarget = db.prepare(`
    INSERT INTO scheduled_job_targets (job_id, session_id, sort_order)
    VALUES (?, ?, ?)
  `);
  for (const [index, target] of job.targets.entries()) {
    insertTarget.run(job.id, target.sessionId, index);
  }
}

function listTargetsForJob(db: SqliteDatabase, jobId: string): ScheduledJobTarget[] {
  return (db.prepare(`
    SELECT job_id, session_id
    FROM scheduled_job_targets
    WHERE job_id = ?
    ORDER BY sort_order ASC, session_id ASC
  `).all(jobId) as ScheduledJobTargetRow[]).map((row) => ({ sessionId: row.session_id }));
}

function listTargetsForJobs(db: SqliteDatabase, jobIds: string[]): Map<string, ScheduledJobTarget[]> {
  const targets = new Map<string, ScheduledJobTarget[]>();
  if (jobIds.length === 0) {
    return targets;
  }
  const placeholders = jobIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT job_id, session_id
    FROM scheduled_job_targets
    WHERE job_id IN (${placeholders})
    ORDER BY job_id ASC, sort_order ASC, session_id ASC
  `).all(...jobIds) as ScheduledJobTargetRow[];
  for (const row of rows) {
    const current = targets.get(row.job_id) ?? [];
    current.push({ sessionId: row.session_id });
    targets.set(row.job_id, current);
  }
  return targets;
}

function isSqliteConstraintError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && String((error as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT");
}
