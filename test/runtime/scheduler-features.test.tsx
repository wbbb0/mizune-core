import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import pino from "pino";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { ScheduledJobStore } from "../../src/runtime/scheduler/jobStore.ts";
import { Scheduler } from "../../src/runtime/scheduler/scheduler.ts";
import type { ScheduledJob } from "../../src/runtime/scheduler/types.ts";

const NOW = Date.UTC(2026, 0, 1);

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "job-1",
    name: "计划任务",
    enabled: true,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    schedule: { kind: "cron", expr: "* * * * * *", tz: "UTC" },
    instruction: "原始指令",
    targets: [{ sessionId: "qqbot:p:owner" }],
    state: {
      nextRunAtMs: null,
      lastRunAtMs: null,
      lastRunStatus: null,
      lastDurationMs: null,
      lastError: null,
      consecutiveErrors: 0
    },
    ...overrides
  };
}

async function fixture(
  t: TestContext,
  onTrigger: (job: ScheduledJob) => Promise<void>,
  job = createJob(),
  start = true
) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const dataDir = await mkdtemp(join(tmpdir(), "mizune-scheduler-test-"));
  const logger = pino({ level: "silent" });
  const database = new StateDatabase(dataDir, logger);
  const store = new ScheduledJobStore(dataDir, logger, database);
  await store.init();
  await store.createRow(job);
  const scheduler = new Scheduler(store, logger, onTrigger);
  t.after(async () => {
    await scheduler.stop();
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  if (start) await scheduler.start();
  return { store, scheduler, jobId: job.id };
}

async function advance(t: TestContext, ms: number): Promise<void> {
  t.mock.timers.tick(ms);
  await setImmediate();
}

for (const outcome of ["success", "failure"] as const) {
  for (const action of ["stop", "disable", "remove"] as const) {
    test(`${action} prevents an in-flight cron ${outcome} from restoring its schedule`, async t => {
      const release = deferred();
      let calls = 0;
      const { store, scheduler, jobId } = await fixture(t, async () => {
        calls += 1;
        await release.promise;
      });
      await advance(t, 1000);
      assert.equal(calls, 1);
      assert.equal((await store.getRow(jobId))?.state.lastRunStatus, "running");

      if (action === "stop") await scheduler.stop();
      if (action === "disable") await scheduler.setEnabled(jobId, false);
      if (action === "remove") assert.equal(await scheduler.removeJob(jobId), true);
      if (outcome === "success") release.resolve();
      else release.reject(new Error("任务失败"));
      await setImmediate();
      await advance(t, 60_000);
      assert.equal(calls, 1);

      const saved = await store.getRow(jobId);
      if (action === "remove") {
        assert.equal(saved, null);
      } else {
        assert.equal(saved?.enabled, action !== "disable");
        assert.equal(saved?.state.lastRunStatus, outcome === "success" ? "ok" : "error");
        assert.equal(saved?.state.nextRunAtMs, null);
      }
    });
  }

  test(`reload preserves an active cron ${outcome} without overlap or false crash recovery`, async t => {
    const release = deferred();
    let calls = 0;
    const { store, scheduler, jobId } = await fixture(t, async () => {
      calls += 1;
      if (calls === 1) await release.promise;
    });
    await advance(t, 1000);
    await scheduler.reloadFromStore();
    await scheduler.reloadFromStore();
    assert.equal((await store.getRow(jobId))?.state.lastRunStatus, "running");
    assert.equal((await store.getRow(jobId))?.state.consecutiveErrors, 0);
    await advance(t, 4000);
    assert.equal(calls, 1);
    if (outcome === "success") release.resolve();
    else release.reject(new Error("任务失败"));
    await setImmediate();
    assert.equal((await store.getRow(jobId))?.state.consecutiveErrors, outcome === "success" ? 0 : 1);
    await advance(t, 1000);
    assert.equal(calls, 2);
  });

  test(`an edited cron survives its old ${outcome} and next runs the latest definition`, async t => {
    const release = deferred();
    const calls: ScheduledJob[] = [];
    const job = createJob();
    job.state.consecutiveErrors = 4;
    const { store, scheduler, jobId } = await fixture(t, async current => {
      calls.push(current);
      if (calls.length === 1) await release.promise;
    }, job);
    await advance(t, 1000);
    const patch = {
      name: "修改后的任务",
      instruction: "新的指令",
      schedule: { kind: "cron", expr: "*/5 * * * * *", tz: "Asia/Shanghai" },
      targets: [{ sessionId: "qqbot:p:new-owner" }]
    };
    await store.patchRow(jobId, patch);
    await scheduler.reloadFromStore();
    if (outcome === "success") release.resolve();
    else release.reject(new Error("旧任务的第五次失败"));
    await setImmediate();
    const saved = await store.getRow(jobId);
    assert.ok(saved);
    assert.equal(saved.enabled, true);
    assert.equal(saved.name, patch.name);
    assert.equal(saved.instruction, patch.instruction);
    assert.deepEqual(saved.schedule, patch.schedule);
    assert.deepEqual(saved.targets, patch.targets);
    assert.equal(saved.state.consecutiveErrors, 0);
    await advance(t, 3000);
    assert.equal(calls.length, 1);
    await advance(t, 1000);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.instruction, patch.instruction);
    assert.deepEqual(calls[1]?.targets, patch.targets);
  });

  test(`a one-shot ${outcome} during reload is consumed once, not recovered as interrupted`, async t => {
    const release = deferred();
    let calls = 0;
    const { store, scheduler, jobId } = await fixture(t, async () => {
      calls += 1;
      await release.promise;
    }, createJob({ schedule: { kind: "at", runAtMs: NOW + 1000, tz: "UTC" } }));
    await advance(t, 1000);
    await scheduler.reloadFromStore();
    assert.equal((await store.getRow(jobId))?.state.lastRunStatus, "running");
    await advance(t, 1000);
    assert.equal(calls, 1);
    if (outcome === "success") release.resolve();
    else release.reject(new Error("任务失败"));
    await setImmediate();
    assert.equal(await store.getRow(jobId), null);
    await advance(t, 10_000);
    assert.equal(calls, 1);
  });

  test(`a changed one-shot is not deleted by its previous ${outcome}`, async t => {
    const release = deferred();
    const calls: ScheduledJob[] = [];
    const { store, scheduler, jobId } = await fixture(t, async current => {
      calls.push(current);
      if (calls.length === 1) await release.promise;
    }, createJob({ schedule: { kind: "delay", delayMs: 1000 } }));
    await advance(t, 1000);
    await store.patchRow(jobId, {
      instruction: "改期后的指令",
      schedule: { kind: "at", runAtMs: NOW + 10_000, tz: "UTC" }
    });
    await scheduler.reloadFromStore();
    if (outcome === "success") release.resolve();
    else release.reject(new Error("旧任务失败"));
    await setImmediate();
    assert.equal((await store.getRow(jobId))?.instruction, "改期后的指令");
    assert.equal((await store.getRow(jobId))?.state.nextRunAtMs, NOW + 10_000);
    await advance(t, 8000);
    assert.equal(calls.length, 1);
    await advance(t, 1000);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.instruction, "改期后的指令");
    assert.equal(await store.getRow(jobId), null);
  });
}

test("completion cannot overwrite an edit made before the data editor requests reload", async t => {
  const release = deferred();
  const { store, scheduler, jobId } = await fixture(t, () => release.promise);
  await advance(t, 1000);
  await store.patchRow(jobId, { name: "新名称", instruction: "新指令", enabled: false });
  release.resolve();
  await setImmediate();
  const current = await store.getRow(jobId);
  assert.equal(current?.name, "新名称");
  assert.equal(current?.instruction, "新指令");
  assert.equal(current?.enabled, false);
  await scheduler.reloadFromStore();
  assert.equal((await store.getRow(jobId))?.enabled, false);
});

test("cron failures accumulate only for their current definition and stop at five", async t => {
  let calls = 0;
  const { store, jobId } = await fixture(t, async () => {
    calls += 1;
    throw new Error("boom");
  });
  for (let index = 0; index < 5; index += 1) await advance(t, 1000);
  const current = await store.getRow(jobId);
  assert.equal(current?.enabled, false);
  assert.equal(current?.state.consecutiveErrors, 5);
  assert.equal(current?.state.nextRunAtMs, null);
  assert.match(current?.state.lastError ?? "", /已自动停用/);
  await advance(t, 60_000);
  assert.equal(calls, 5);
});

test("stop invalidates a startup that is still loading jobs", async t => {
  let calls = 0;
  const { store, scheduler } = await fixture(t, async () => { calls += 1; }, createJob(), false);
  const loaded = deferred();
  const release = deferred();
  const list = store.list.bind(store);
  t.mock.method(store, "list", async () => {
    const jobs = await list();
    loaded.resolve();
    await release.promise;
    return jobs;
  });
  const startup = scheduler.start();
  await loaded.promise;
  await scheduler.stop();
  release.resolve();
  await startup;
  await advance(t, 60_000);
  assert.equal(calls, 0);
});

test("reload does not cancel a newer enable request while loading an old disabled snapshot", async t => {
  let calls = 0;
  const { store, scheduler, jobId } = await fixture(t, async () => { calls += 1; }, createJob({ enabled: false }));
  const loaded = deferred();
  const release = deferred();
  const list = store.list.bind(store);
  t.mock.method(store, "list", async () => {
    const jobs = await list();
    loaded.resolve();
    await release.promise;
    return jobs;
  });
  const reload = scheduler.reloadFromStore();
  await loaded.promise;
  await scheduler.setEnabled(jobId, true);
  release.resolve();
  await reload;
  await advance(t, 1000);
  assert.equal(calls, 1);
});

test("creating or enabling while stopped waits for an explicit start", async t => {
  let calls = 0;
  const { store, scheduler, jobId } = await fixture(t, async () => { calls += 1; });
  await scheduler.stop();
  await scheduler.setEnabled(jobId, true);
  const created = await store.createRow(createJob({ id: "job-2" }));
  await scheduler.createJob(created);
  await advance(t, 1000);
  assert.equal(calls, 0);
  await scheduler.start();
  await advance(t, 1000);
  assert.equal(calls, 2);
});

test("startup recovers genuinely interrupted cron jobs and removes interrupted one-shots", async t => {
  const job = createJob();
  job.state.lastRunStatus = "running";
  job.state.lastRunAtMs = NOW - 1000;
  const { store, scheduler, jobId } = await fixture(t, async () => {}, job, false);
  await store.createRow({ ...job, id: "interrupted-once", schedule: { kind: "delay", delayMs: 1000 } });
  await scheduler.start();
  const recovered = await store.getRow(jobId);
  assert.equal(recovered?.state.lastRunStatus, "error");
  assert.equal(recovered?.state.consecutiveErrors, 1);
  assert.equal(recovered?.state.nextRunAtMs, NOW + 1000);
  assert.equal(await store.getRow("interrupted-once"), null);
});

test("long one-shot waits do not overflow into an immediate invocation", async t => {
  let calls = 0;
  const delayMs = 30 * 24 * 60 * 60 * 1000;
  const { store, jobId } = await fixture(t, async () => { calls += 1; }, createJob({ schedule: { kind: "delay", delayMs } }));
  await advance(t, 1000);
  assert.equal(calls, 0);
  assert.equal((await store.getRow(jobId))?.state.nextRunAtMs, NOW + delayMs);
});

for (const outcome of ["success", "failure"] as const) {
  test(`disable then enable preserves the new cron activation after an old ${outcome}`, async t => {
    const release = deferred();
    let calls = 0;
    const job = createJob();
    job.state.consecutiveErrors = 4;
    const { store, scheduler, jobId } = await fixture(t, async () => {
      calls += 1;
      if (calls === 1) await release.promise;
    }, job);
    await advance(t, 1000);
    await scheduler.setEnabled(jobId, false);
    await scheduler.setEnabled(jobId, true);
    if (outcome === "success") release.resolve();
    else release.reject(new Error("旧激活的第五次失败"));
    await setImmediate();
    assert.equal((await store.getRow(jobId))?.enabled, true);
    assert.equal((await store.getRow(jobId))?.state.consecutiveErrors, 0);
    await advance(t, 1000);
    assert.equal(calls, 2);
  });

  for (const change of ["disable-enable", "rename"] as const) {
    test(`an in-flight one-shot ${outcome} after ${change} preserves the row without replaying the occurrence`, async t => {
      const release = deferred();
      let calls = 0;
      const { store, scheduler, jobId } = await fixture(t, async () => {
        calls += 1;
        await release.promise;
      }, createJob({ schedule: { kind: "delay", delayMs: 1000 } }));
      await advance(t, 1000);
      if (change === "disable-enable") {
        await scheduler.setEnabled(jobId, false);
        await scheduler.setEnabled(jobId, true);
      } else {
        await store.patchRow(jobId, { name: "新的名称" });
        await scheduler.reloadFromStore();
      }
      if (outcome === "success") release.resolve();
      else release.reject(new Error("旧任务失败"));
      await setImmediate();
      const saved = await store.getRow(jobId);
      assert.ok(saved);
      assert.equal(saved.enabled, true);
      assert.equal(saved.state.lastRunStatus, outcome === "success" ? "ok" : "error");
      assert.equal(saved.state.nextRunAtMs, null);
      await scheduler.reloadFromStore();
      await scheduler.stop();
      await scheduler.start();
      await advance(t, 10_000);
      assert.equal(calls, 1);
    });
  }
}

test("a removed and recreated id does not inherit the old invocation's ownership", async t => {
  const release = deferred();
  const { store, scheduler, jobId } = await fixture(t, () => release.promise,
    createJob({ schedule: { kind: "delay", delayMs: 1000 } }));
  await advance(t, 1000);
  const snapshot = await store.getRow(jobId);
  assert.ok(snapshot);
  const oldVersion = store.getVersion(jobId);
  await scheduler.removeJob(jobId);
  assert.equal(store.getVersion(jobId), null);
  await store.createRow(snapshot);
  assert.notEqual(store.getVersion(jobId)?.identity, oldVersion?.identity);
  await scheduler.stop();
  release.resolve();
  await setImmediate();
  assert.deepEqual(await store.getRow(jobId), snapshot);
});

test("interactive startup can activate new tasks without consuming existing instance jobs", async t => {
  const calls: string[] = [];
  const { store, scheduler, jobId } = await fixture(t, async job => { calls.push(job.id); },
    createJob({ schedule: { kind: "delay", delayMs: 1000 } }), false);
  await scheduler.start({ loadExisting: false });
  await advance(t, 1000);
  assert.deepEqual(calls, []);
  assert.equal((await store.getRow(jobId))?.state.lastRunStatus, null);
  const created = await store.createRow(createJob({ id: "interactive-job" }));
  await scheduler.createJob(created);
  await advance(t, 1000);
  assert.deepEqual(calls, [created.id]);
  assert.ok(await store.getRow(jobId));
});

for (const outcome of ["success", "failure"] as const) {
  test(`saving a stale full editor draft cannot replay an in-flight one-shot ${outcome}`, async t => {
    const release = deferred();
    let calls = 0;
    const { store, scheduler, jobId } = await fixture(t, async () => {
      calls += 1;
      if (calls === 1) await release.promise;
    }, createJob({ schedule: { kind: "delay", delayMs: 1000 } }));
    const oldDraft = await store.getRow(jobId);
    assert.ok(oldDraft);
    assert.equal(oldDraft.state.lastRunStatus, null);
    await advance(t, 1000);
    await store.patchRow(jobId, { ...oldDraft, name: "从旧窗口改名" });
    assert.equal((await store.getRow(jobId))?.state.lastRunStatus, "running");
    await scheduler.reloadFromStore();
    if (outcome === "success") release.resolve();
    else release.reject(new Error("任务失败"));
    await setImmediate();
    await advance(t, 10_000);
    assert.equal(calls, 1);
    const current = await store.getRow(jobId);
    assert.equal(current?.name, "从旧窗口改名");
    assert.equal(current?.state.lastRunStatus, outcome === "success" ? "ok" : "error");
    assert.equal(current?.state.nextRunAtMs, null);
  });
}

test("an edit committed before onTrigger starts invalidates the old invocation even before reload", async t => {
  const calls: string[] = [];
  const { store, scheduler, jobId } = await fixture(t, async job => { calls.push(job.instruction); });
  const written = deferred();
  const release = deferred();
  const transition = store.transitionRuntime.bind(store);
  let pause = true;
  t.mock.method(store, "transitionRuntime", async (...args: Parameters<typeof transition>) => {
    const result = await transition(...args);
    if (pause && result?.state.lastRunStatus === "running") {
      pause = false;
      written.resolve();
      await release.promise;
    }
    return result;
  });
  t.mock.timers.tick(1000);
  await written.promise;
  await store.patchRow(jobId, { instruction: "提交后的指令" });
  release.resolve();
  await setImmediate();
  assert.deepEqual(calls, []);
  await scheduler.reloadFromStore();
  await advance(t, 1000);
  assert.deepEqual(calls, ["提交后的指令"]);
});
