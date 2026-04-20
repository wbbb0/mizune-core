import assert from "node:assert/strict";
import pino from "pino";
import { Scheduler } from "../../src/runtime/scheduler/scheduler.ts";
import type { ScheduledJob } from "../../src/runtime/scheduler/types.ts";
import { runCase } from "../helpers/forward-test-support.tsx";

class InMemoryScheduledJobStore {
  constructor(private jobs: ScheduledJob[]) {}

  async list(): Promise<ScheduledJob[]> {
    return this.jobs.map((job) => ({
      ...job,
      targets: [...job.targets],
      state: { ...job.state }
    }));
  }

  async update(job: ScheduledJob): Promise<void> {
    this.jobs = this.jobs.map((item) => item.id === job.id ? {
      ...job,
      targets: [...job.targets],
      state: { ...job.state }
    } : item);
  }

  async remove(jobId: string): Promise<boolean> {
    const next = this.jobs.filter((item) => item.id !== jobId);
    const removed = next.length !== this.jobs.length;
    this.jobs = next;
    return removed;
  }
}

function createCronJob(): ScheduledJob {
  const now = Date.now();
  return {
    id: "job_cron_1",
    name: "失败重试任务",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: {
      kind: "cron",
      expr: "* * * * *",
      tz: "Asia/Shanghai"
    },
    instruction: "执行一个会失败的计划任务",
    targets: [{ sessionId: "qqbot:p:owner" }],
    state: {
      nextRunAtMs: null,
      lastRunAtMs: null,
      lastRunStatus: null,
      lastDurationMs: null,
      lastError: null,
      consecutiveErrors: 0
    }
  };
}

async function main() {
  await runCase("scheduler disables cron jobs after repeated consecutive failures", async () => {
    const store = new InMemoryScheduledJobStore([createCronJob()]);
    const scheduler = new Scheduler(
      store as never,
      pino({ level: "silent" }),
      async () => {
        throw new Error("boom");
      }
    );

    for (let index = 0; index < 5; index += 1) {
      const current = (await store.list())[0];
      assert.ok(current);
      await (scheduler as any).runJob(current);
    }

    const finalJob = (await store.list())[0];
    assert.ok(finalJob);
    assert.equal(finalJob.enabled, false);
    assert.equal(finalJob.state.consecutiveErrors, 5);
    assert.equal(finalJob.state.nextRunAtMs, null);
    assert.match(String(finalJob.state.lastError ?? ""), /已自动停用/);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
