import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ScheduledJobStore } from "../../src/runtime/scheduler/jobStore.ts";
import type { ScheduledJob } from "../../src/runtime/scheduler/types.ts";

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-scheduled-job-store-test-"));
  const store = new ScheduledJobStore(dataDir, pino({ level: "silent" }));
  await store.init();
  return {
    dataDir,
    store,
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

function createJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "job-1",
    name: "daily",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: {
      kind: "delay",
      delayMs: 1000
    },
    instruction: "ping",
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

test("ScheduledJobStore persists jobs in state sqlite without legacy json output", async () => {
  const harness = await createHarness();
  try {
    const created = await harness.store.create({
      name: "daily",
      schedule: {
        kind: "delay",
        delayMs: 1000
      },
      instruction: "ping",
      targets: [{ sessionId: "qqbot:p:owner" }]
    });
    assert.equal((await harness.store.list()).length, 1);
    assert.equal((await harness.store.getRow(created.id))?.name, "daily");
    const db = (harness.store as any).stateDatabase.getDb();
    const jobColumns = (db.prepare("PRAGMA table_info(scheduled_jobs)").all() as Array<{ name: string }>).map((column) => column.name);
    assert.equal(jobColumns.includes("schedule_json"), false);
    assert.equal(jobColumns.includes("targets_json"), false);
    assert.equal(jobColumns.includes("state_json"), false);
    assert.equal(jobColumns.includes("schedule_kind"), true);
    assert.equal(jobColumns.includes("next_run_at_ms"), true);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM scheduled_job_targets").get() as { count: number }).count, 1);
    await assert.rejects(access(join(harness.dataDir, "scheduled-jobs.json")), /ENOENT/u);
  } finally {
    await harness.cleanup();
  }
});

test("ScheduledJobStore ignores existing legacy scheduled jobs json", async () => {
  const harness = await createHarness();
  try {
    await writeFile(join(harness.dataDir, "scheduled-jobs.json"), JSON.stringify({
      version: 1,
      jobs: [createJob({ id: "legacy-job" })]
    }), "utf8");

    assert.deepEqual(await harness.store.list(), []);
  } finally {
    await harness.cleanup();
  }
});

test("ScheduledJobStore row creation rejects duplicates and preserves insertion order", async () => {
  const harness = await createHarness();
  try {
    await harness.store.createRow(createJob({ id: "job-b", createdAtMs: 1 }));
    await harness.store.createRow(createJob({ id: "job-a", createdAtMs: 1 }));
    assert.deepEqual((await harness.store.listRows()).rows.map((job) => job.id), ["job-b", "job-a"]);

    await assert.rejects(
      () => harness.store.createRow(createJob({ id: "job-b", name: "overwrite" })),
      /already exists/u
    );
    assert.equal((await harness.store.getRow("job-b"))?.name, "daily");

    const patched = await harness.store.patchRow("job-b", { name: "updated" });
    assert.equal(patched.name, "updated");
    await assert.rejects(
      () => harness.store.patchRow("job-b", { id: "changed" }),
      /id cannot be changed/u
    );

    await harness.store.deleteRow("job-b");
    assert.deepEqual((await harness.store.listRows()).rows.map((job) => job.id), ["job-a"]);
  } finally {
    await harness.cleanup();
  }
});

test("ScheduledJobStore runtime transitions preserve the latest definition and ignore missing jobs", async () => {
  const harness = await createHarness();
  try {
    await harness.store.createRow(createJob());
    await harness.store.patchRow("job-1", {
      name: "new name",
      instruction: "new instruction",
      targets: [{ sessionId: "qqbot:p:new-owner" }]
    });
    const updated = await harness.store.transitionRuntime("job-1", (current) => ({
      type: "update",
      state: { ...current.state, lastRunStatus: "ok", lastDurationMs: 42 }
    }));
    assert.equal(updated?.name, "new name");
    assert.equal(updated?.instruction, "new instruction");
    assert.deepEqual(updated?.targets, [{ sessionId: "qqbot:p:new-owner" }]);
    assert.equal((await harness.store.getRow("job-1"))?.state.lastDurationMs, 42);

    const skipped = await harness.store.transitionRuntime("job-1", () => null);
    assert.equal(skipped, null);
    assert.equal((await harness.store.getRow("job-1"))?.state.lastDurationMs, 42);
    await harness.store.transitionRuntime("job-1", () => ({ type: "remove" }));
    assert.equal(await harness.store.getRow("job-1"), null);
    assert.equal(await harness.store.transitionRuntime("missing-job", () => {
      assert.fail("missing records must not receive a transition");
    }), null);
  } finally {
    await harness.cleanup();
  }
});

test("ScheduledJobStore versions follow definition changes and reclaim deleted identities", async () => {
  const harness = await createHarness();
  try {
    const created = await harness.store.createRow(createJob());
    const initial = harness.store.getVersion(created.id);
    assert.ok(initial);
    await harness.store.transitionRuntime(created.id, current => ({
      type: "update", state: { ...current.state, lastRunStatus: "running", lastRunAtMs: 100 }
    }));
    assert.equal(harness.store.getVersion(created.id), initial);
    await harness.store.patchRow(created.id, { updatedAtMs: 200 });
    assert.equal(harness.store.getVersion(created.id), initial);

    await harness.store.patchRow(created.id, { enabled: false });
    const disabled = harness.store.getVersion(created.id);
    assert.equal(disabled?.identity, initial.identity);
    assert.notEqual(disabled?.definition, initial.definition);
    await harness.store.patchRow(created.id, { enabled: true });
    assert.notEqual(harness.store.getVersion(created.id)?.definition, disabled?.definition);
    assert.equal((await harness.store.getRow(created.id))?.state.lastRunStatus, "running");

    await harness.store.patchRow(created.id, { instruction: "new instruction" });
    const edited = await harness.store.getRow(created.id);
    assert.equal(edited?.state.lastRunStatus, null);
    assert.equal(edited?.state.lastRunAtMs, null);
    await harness.store.deleteRow(created.id);
    assert.equal(harness.store.getVersion(created.id), null);
    await harness.store.createRow(created);
    assert.notEqual(harness.store.getVersion(created.id)?.identity, initial.identity);
  } finally {
    await harness.cleanup();
  }
});
