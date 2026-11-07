import { Cron } from "croner";
import type { Logger } from "pino";
import { sameScheduledJobDefinition, type ScheduledJobStore, type ScheduledJobVersion } from "./jobStore.ts";
import type { ScheduledJob } from "./types.ts";

const MAX_CRON_CONSECUTIVE_ERRORS = 5;

type ScheduleEntry = {
  job: ScheduledJob;
  epoch: number;
  cron: Cron | null;
  timer: NodeJS.Timeout | null;
};

type ActiveRun = {
  job: ScheduledJob;
  startedAt: number;
  previousState: ScheduledJob["state"] | null;
  version: ScheduledJobVersion | null;
};

type RunOutcome = { ok: true } | { ok: false; error: unknown };

export class Scheduler {
  private readonly schedules = new Map<string, ScheduleEntry>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly controls = new Map<string, object>();
  private epoch = 0;
  private started = false;

  constructor(
    private readonly store: ScheduledJobStore,
    private readonly logger: Logger,
    private readonly onTrigger: (job: ScheduledJob) => Promise<void>
  ) {}

  async start(options: { loadExisting?: boolean } = {}): Promise<void> {
    const epoch = ++this.epoch;
    this.started = true;
    this.clearSchedules();
    if (options.loadExisting === false) {
      return;
    }
    try {
      const jobs = await this.store.list();
      for (const job of jobs) {
        if (!this.isCurrentEpoch(epoch)) {
          return;
        }
        if (this.schedules.has(job.id) || this.controls.has(job.id)) {
          continue;
        }
        const current = await this.recoverInterruptedJob(job, epoch);
        if (current && !this.schedules.has(job.id) && !this.controls.has(job.id)) {
          await this.schedule(current, epoch);
        }
      }
    } catch (error: unknown) {
      if (this.isCurrentEpoch(epoch)) {
        await this.stop();
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.epoch += 1;
    this.clearSchedules();
  }

  async createJob(job: ScheduledJob): Promise<void> {
    if (!this.schedules.has(job.id) && !this.controls.has(job.id)) {
      await this.schedule(job, this.epoch);
    }
  }

  async reloadFromStore(): Promise<void> {
    await this.start();
  }

  async removeJob(jobId: string): Promise<boolean> {
    const control = {};
    this.controls.set(jobId, control);
    this.unschedule(jobId);
    let removed = false;
    try {
      await this.store.transitionRuntime(jobId, () => {
        if (this.controls.get(jobId) !== control) {
          return null;
        }
        removed = true;
        return { type: "remove" };
      });
      return removed;
    } finally {
      if (this.controls.get(jobId) === control) {
        this.unschedule(jobId);
        this.controls.delete(jobId);
      }
    }
  }

  async setEnabled(jobId: string, enabled: boolean): Promise<ScheduledJob | null> {
    const control = {};
    this.controls.set(jobId, control);
    this.unschedule(jobId);
    try {
      const next = await this.store.transitionRuntime(jobId, (current) => this.controls.get(jobId) === control ? {
        type: "update",
        enabled,
        state: {
          ...current.state,
          nextRunAtMs: enabled ? current.state.nextRunAtMs : null
        }
      } : null);
      if (next && this.controls.get(jobId) === control) {
        await this.schedule(next, this.epoch);
      }
      return next;
    } finally {
      if (this.controls.get(jobId) === control) {
        this.controls.delete(jobId);
      }
    }
  }

  async listJobs(): Promise<ScheduledJob[]> {
    return this.store.list();
  }

  private async recoverInterruptedJob(job: ScheduledJob, epoch: number): Promise<ScheduledJob | null> {
    if (job.state.lastRunStatus !== "running" || this.activeRuns.has(job.id)) {
      return job;
    }
    return this.store.transitionRuntime(job.id, (current) => {
      if (!this.isCurrentEpoch(epoch) || this.activeRuns.has(job.id)) {
        return null;
      }
      if (current.state.lastRunStatus !== "running") {
        return { type: "update", state: current.state };
      }
      if (current.schedule.kind !== "cron") {
        this.logger.warn(
          { jobId: current.id, name: current.name, scheduleKind: current.schedule.kind },
          "scheduled_job_removed_after_interrupted_one_shot_run"
        );
        return { type: "remove" };
      }
      this.logger.warn(
        { jobId: current.id, name: current.name },
        "scheduled_job_recovered_after_interrupted_run"
      );
      return {
        type: "update",
        state: {
          ...current.state,
          lastRunStatus: "error",
          lastError: "Recovered from interrupted run during startup",
          consecutiveErrors: current.state.consecutiveErrors + 1,
          nextRunAtMs: null
        }
      };
    });
  }

  private async schedule(job: ScheduledJob, epoch: number): Promise<void> {
    if (!this.isCurrentEpoch(epoch)) {
      return;
    }
    this.unschedule(job.id);
    if (!job.enabled || isCompletedOneShot(job)) {
      return;
    }
    const entry: ScheduleEntry = { job, epoch, cron: null, timer: null };
    this.schedules.set(job.id, entry);
    // Reloads may replace the definition while an invocation is still running.
    // Keep the new entry pending until that invocation releases the job.
    if (!this.activeRuns.has(job.id)) {
      await this.armSchedule(entry);
    }
  }

  private async armSchedule(entry: ScheduleEntry): Promise<void> {
    if (!this.ownsSchedule(entry)) {
      return;
    }
    const { job } = entry;
    if (isCompletedOneShot(job)) {
      this.unschedule(job.id);
      return;
    }
    const cron = job.schedule.kind === "cron"
      ? new Cron(job.schedule.expr, { timezone: job.schedule.tz })
      : null;
    entry.cron = cron;
    const nextRunAtMs = cron
      ? (cron.nextRun()?.getTime() ?? null)
      : job.schedule.kind === "delay"
        ? job.createdAtMs + job.schedule.delayMs
        : job.schedule.kind === "at" ? job.schedule.runAtMs : null;
    const current = await this.store.transitionRuntime(job.id, (latest) => {
      if (!this.ownsSchedule(entry) || !latest.enabled || !sameScheduledJobDefinition(latest, job)) {
        return null;
      }
      return { type: "update", state: { ...latest.state, nextRunAtMs } };
    });
    if (!this.ownsSchedule(entry)) {
      return;
    }
    if (!current || nextRunAtMs === null) {
      this.unschedule(job.id);
      return;
    }
    entry.job = current;
    if (cron) {
      cron.schedule(() => this.dispatch(entry));
    } else if (nextRunAtMs <= Date.now()) {
      entry.timer = setTimeout(() => { void this.dispatch(entry); }, 0);
    } else {
      // Croner also owns long one-shot waits, avoiding the setTimeout 32-bit limit.
      entry.cron = new Cron(new Date(nextRunAtMs), () => this.dispatch(entry));
    }
  }

  private async dispatch(entry: ScheduleEntry): Promise<void> {
    try {
      await this.runJob(entry);
    } catch (error: unknown) {
      this.logger.error({ error, jobId: entry.job.id }, "scheduled_job_transition_failed");
    }
  }

  private async runJob(entry: ScheduleEntry): Promise<void> {
    const jobId = entry.job.id;
    if (!this.ownsSchedule(entry) || this.activeRuns.has(jobId)) {
      return;
    }
    this.clearHandle(entry);
    const run: ActiveRun = { job: entry.job, startedAt: Date.now(), previousState: null, version: null };
    this.activeRuns.set(jobId, run);
    let mayResume = false;
    try {
      const runningJob = await this.store.transitionRuntime(jobId, (current) => {
        if (!this.ownsSchedule(entry) || !current.enabled || !sameScheduledJobDefinition(current, entry.job)) {
          return null;
        }
        run.previousState = current.state;
        run.version = this.store.getVersion(jobId);
        return {
          type: "update",
          state: {
            ...current.state,
            nextRunAtMs: null,
            lastRunAtMs: run.startedAt,
            lastRunStatus: "running",
            lastError: null
          }
        };
      });
      if (!runningJob || !this.ownsSchedule(entry)
        || this.store.getVersion(jobId)?.definition !== run.version?.definition) {
        await this.restoreUnstartedRun(run);
        mayResume = true;
        return;
      }
      run.job = runningJob;
      this.logger.info(
        { jobId, name: runningJob.name, targetCount: runningJob.targets.length },
        "scheduled_job_started"
      );
      let outcome: RunOutcome;
      try {
        await this.onTrigger(runningJob);
        outcome = { ok: true };
      } catch (error: unknown) {
        outcome = { ok: false, error };
      }
      await this.finishRun(run, outcome);
      mayResume = true;
    } finally {
      this.activeRuns.delete(jobId);
      const pending = this.schedules.get(jobId);
      if (pending && this.ownsSchedule(pending)) {
        if (mayResume) {
          const current = await this.store.getRow(jobId);
          if (this.ownsSchedule(pending)) {
            if (current?.enabled) {
              pending.job = current;
              await this.armSchedule(pending);
            } else {
              this.unschedule(jobId);
            }
          }
        } else {
          // A failed state write must not replay a one-shot with unknown outcome.
          this.unschedule(jobId);
        }
      }
    }
  }

  private async restoreUnstartedRun(run: ActiveRun): Promise<void> {
    const previous = run.previousState;
    if (!previous) {
      return;
    }
    await this.store.transitionRuntime(run.job.id, (current) => this.ownsRunState(current, run)
      ? { type: "update", state: { ...previous, nextRunAtMs: current.state.nextRunAtMs } }
      : null);
  }

  private async finishRun(run: ActiveRun, outcome: RunOutcome): Promise<void> {
    const finishedAt = Date.now();
    const message = outcome.ok ? null : outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    await this.store.transitionRuntime(run.job.id, (current) => {
      if (!this.ownsRunState(current, run)) {
        return null;
      }
      const unchanged = this.store.getVersion(current.id)?.definition === run.version?.definition;
      if (unchanged && current.enabled && run.job.schedule.kind !== "cron") {
        return { type: "remove" };
      }
      // An old invocation may report its outcome, but cannot disable an edited
      // definition or restore any of its old configuration/next-run fields.
      const consecutiveErrors = outcome.ok || !unchanged ? 0 : current.state.consecutiveErrors + 1;
      const autoDisable = current.schedule.kind === "cron"
        && consecutiveErrors >= MAX_CRON_CONSECUTIVE_ERRORS;
      if (autoDisable && current.enabled) {
        this.logger.warn(
          { jobId: current.id, name: current.name, consecutiveErrors },
          "scheduled_job_disabled_after_consecutive_failures"
        );
      }
      return {
        type: "update",
        enabled: current.enabled && !autoDisable,
        state: {
          ...current.state,
          lastRunStatus: outcome.ok ? "ok" : "error",
          lastDurationMs: finishedAt - run.startedAt,
          lastError: autoDisable
            ? `${message} (连续失败次数达到 ${MAX_CRON_CONSECUTIVE_ERRORS} 次，已自动停用)`
            : message,
          consecutiveErrors,
          nextRunAtMs: autoDisable ? null : current.state.nextRunAtMs
        }
      };
    });
    if (outcome.ok) {
      this.logger.info({ jobId: run.job.id, durationMs: finishedAt - run.startedAt }, "scheduled_job_succeeded");
    } else {
      this.logger.error({ error: outcome.error, jobId: run.job.id }, "scheduled_job_failed");
    }
  }

  private ownsRunState(current: ScheduledJob, run: ActiveRun): boolean {
    return this.activeRuns.get(current.id) === run
      && run.version !== null
      && this.store.getVersion(current.id)?.identity === run.version.identity
      && current.state.lastRunAtMs === run.startedAt
      && current.state.lastRunStatus === "running";
  }

  private isCurrentEpoch(epoch: number): boolean {
    return this.started && this.epoch === epoch;
  }

  private ownsSchedule(entry: ScheduleEntry): boolean {
    return this.isCurrentEpoch(entry.epoch) && this.schedules.get(entry.job.id) === entry;
  }

  private clearHandle(entry: ScheduleEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.cron?.stop();
    entry.cron = null;
  }

  private unschedule(jobId: string): void {
    const entry = this.schedules.get(jobId);
    if (entry) {
      this.clearHandle(entry);
      this.schedules.delete(jobId);
    }
  }

  private clearSchedules(): void {
    for (const jobId of this.schedules.keys()) {
      this.unschedule(jobId);
    }
  }
}

function isCompletedOneShot(job: ScheduledJob): boolean {
  return job.schedule.kind !== "cron"
    && (job.state.lastRunStatus === "ok" || job.state.lastRunStatus === "error");
}
