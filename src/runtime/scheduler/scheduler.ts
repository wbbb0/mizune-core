import { Cron } from "croner";
import type { Logger } from "pino";
import type { ScheduledJobStore } from "./jobStore.ts";
import type { ScheduledJob } from "./types.ts";

const MAX_CRON_CONSECUTIVE_ERRORS = 5;

export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly cronJobs = new Map<string, Cron>();

  constructor(
    private readonly store: ScheduledJobStore,
    private readonly logger: Logger,
    private readonly onTrigger: (job: ScheduledJob) => Promise<void>
  ) {}

  async start(): Promise<void> {
    const jobs = await this.recoverInterruptedJobs(await this.store.list());
    for (const job of jobs) {
      await this.schedule(job);
    }
  }

  async stop(): Promise<void> {
    for (const jobId of Array.from(this.timers.keys())) {
      this.unschedule(jobId);
    }
    for (const jobId of Array.from(this.cronJobs.keys())) {
      this.unschedule(jobId);
    }
  }

  async createJob(job: ScheduledJob): Promise<void> {
    await this.schedule(job);
  }

  async reloadFromStore(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async removeJob(jobId: string): Promise<boolean> {
    this.unschedule(jobId);
    return this.store.remove(jobId);
  }

  async setEnabled(jobId: string, enabled: boolean): Promise<ScheduledJob | null> {
    const jobs = await this.store.list();
    const current = jobs.find((item) => item.id === jobId);
    if (!current) {
      return null;
    }
    const next: ScheduledJob = {
      ...current,
      enabled,
      updatedAtMs: Date.now(),
      state: {
        ...current.state,
        nextRunAtMs: enabled ? current.state.nextRunAtMs : null
      }
    };
    await this.store.update(next);
    this.unschedule(jobId);
    await this.schedule(next);
    return next;
  }

  async listJobs(): Promise<ScheduledJob[]> {
    return this.store.list();
  }

  private async recoverInterruptedJobs(jobs: ScheduledJob[]): Promise<ScheduledJob[]> {
    const recovered: ScheduledJob[] = [];

    for (const job of jobs) {
      if (job.state.lastRunStatus !== "running") {
        recovered.push(job);
        continue;
      }

      if (job.schedule.kind === "delay" || job.schedule.kind === "at") {
        await this.store.remove(job.id);
        this.logger.warn(
          { jobId: job.id, name: job.name, scheduleKind: job.schedule.kind },
          "scheduled_job_removed_after_interrupted_one_shot_run"
        );
        continue;
      }

      const recoveredJob: ScheduledJob = {
        ...job,
        updatedAtMs: Date.now(),
        state: {
          ...job.state,
          lastRunStatus: "error",
          lastError: "Recovered from interrupted run during startup",
          consecutiveErrors: job.state.consecutiveErrors + 1,
          nextRunAtMs: null
        }
      };
      await this.store.update(recoveredJob);
      this.logger.warn(
        { jobId: job.id, name: job.name },
        "scheduled_job_recovered_after_interrupted_run"
      );
      recovered.push(recoveredJob);
    }

    return recovered;
  }

  private async schedule(job: ScheduledJob): Promise<void> {
    this.unschedule(job.id);
    if (!job.enabled) {
      return;
    }

    if (job.schedule.kind === "delay" || job.schedule.kind === "at") {
      const nextRunAtMs = job.state.nextRunAtMs
        ?? (job.schedule.kind === "delay"
          ? (job.createdAtMs + job.schedule.delayMs)
          : job.schedule.runAtMs);
      if (nextRunAtMs <= Date.now()) {
        await this.runJob({ ...job, state: { ...job.state, nextRunAtMs } });
        return;
      }
      const waitMs = nextRunAtMs - Date.now();
      const timer = setTimeout(() => {
        void this.runJob({ ...job, state: { ...job.state, nextRunAtMs } });
      }, waitMs);
      this.timers.set(job.id, timer);
      if (job.state.nextRunAtMs !== nextRunAtMs) {
        await this.store.update({
          ...job,
          updatedAtMs: Date.now(),
          state: {
            ...job.state,
            nextRunAtMs
          }
        });
      }
      return;
    }

    const cron = new Cron(job.schedule.expr, {
      timezone: job.schedule.tz,
      paused: false
    }, () => {
      void this.runJob(job);
    });
    this.cronJobs.set(job.id, cron);
    const nextRun = cron.nextRun();
    await this.store.update({
      ...job,
      updatedAtMs: Date.now(),
      state: {
        ...job.state,
        nextRunAtMs: nextRun ? nextRun.getTime() : null
      }
    });
  }

  private async runJob(job: ScheduledJob): Promise<void> {
    this.unschedule(job.id);

    const startedAt = Date.now();
    await this.store.update({
      ...job,
      updatedAtMs: startedAt,
      state: {
        ...job.state,
        lastRunAtMs: startedAt,
        lastRunStatus: "running",
        lastError: null
      }
    });

    try {
      this.logger.info({ jobId: job.id, name: job.name, targetCount: job.targets.length }, "scheduled_job_started");
      await this.onTrigger(job);
      const finishedAt = Date.now();
      if (job.schedule.kind === "delay" || job.schedule.kind === "at") {
        await this.store.remove(job.id);
      } else {
        const nextJob = this.afterSuccess(job, startedAt, finishedAt);
        await this.store.update(nextJob);
        await this.schedule(nextJob);
      }
      this.logger.info({ jobId: job.id, durationMs: finishedAt - startedAt }, "scheduled_job_succeeded");
    } catch (error: unknown) {
      const finishedAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      if (job.schedule.kind === "delay" || job.schedule.kind === "at") {
        await this.store.remove(job.id);
      } else {
        const nextJob = this.afterFailure(job, startedAt, finishedAt, message);
        await this.store.update(nextJob);
        await this.schedule(nextJob);
      }
      this.logger.error({ error, jobId: job.id }, "scheduled_job_failed");
    }
  }

  private afterSuccess(job: ScheduledJob, startedAt: number, finishedAt: number): ScheduledJob {
    const base: ScheduledJob = {
      ...job,
      updatedAtMs: finishedAt,
      state: {
        ...job.state,
        lastRunAtMs: startedAt,
        lastRunStatus: "ok",
        lastDurationMs: finishedAt - startedAt,
        lastError: null,
        consecutiveErrors: 0
      }
    };

    if (job.schedule.kind === "delay" || job.schedule.kind === "at") {
      return {
        ...base,
        enabled: false,
        state: {
          ...base.state,
          nextRunAtMs: null
        }
      };
    }

    return base;
  }

  private afterFailure(job: ScheduledJob, startedAt: number, finishedAt: number, message: string): ScheduledJob {
    const nextConsecutiveErrors = job.state.consecutiveErrors + 1;
    const base: ScheduledJob = {
      ...job,
      updatedAtMs: finishedAt,
      state: {
        ...job.state,
        lastRunAtMs: startedAt,
        lastRunStatus: "error",
        lastDurationMs: finishedAt - startedAt,
        lastError: message,
        consecutiveErrors: nextConsecutiveErrors
      }
    };

    if (job.schedule.kind === "delay" || job.schedule.kind === "at") {
      return {
        ...base,
        enabled: false,
        state: {
          ...base.state,
          nextRunAtMs: null
        }
      };
    }

    if (nextConsecutiveErrors >= MAX_CRON_CONSECUTIVE_ERRORS) {
      this.logger.warn(
        {
          jobId: job.id,
          name: job.name,
          consecutiveErrors: nextConsecutiveErrors
        },
        "scheduled_job_disabled_after_consecutive_failures"
      );
      return {
        ...base,
        enabled: false,
        state: {
          ...base.state,
          nextRunAtMs: null,
          lastError: `${message} (连续失败次数达到 ${MAX_CRON_CONSECUTIVE_ERRORS} 次，已自动停用)`
        }
      };
    }

    return base;
  }

  private unschedule(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(jobId);
    }

    const cron = this.cronJobs.get(jobId);
    if (cron) {
      cron.stop();
      this.cronJobs.delete(jobId);
    }
  }
}
