import test from "node:test";
import assert from "node:assert/strict";
import { DerivationQueueFullError, KeyedDerivationRunner } from "../../src/llm/derivations/keyedDerivationRunner.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) throw new Error("Timed out waiting for condition");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test("shared leases deduplicate keys and cancelling one owner preserves the other", async () => {
  const task = deferred();
  let calls = 0;
  let signal!: AbortSignal;
  const runner = new KeyedDerivationRunner({ name: "shared", maxConcurrency: () => 1,
    async run(_key, input) { calls++; signal = input; await task.promise; }
  });
  const firstController = new AbortController();
  const first = runner.acquire(["a", "a"], { abortSignal: firstController.signal });
  const second = runner.acquire(["a"]);
  firstController.abort(new Error("first cancelled"));
  await assert.rejects(first.completion, /first cancelled/);
  assert.equal(signal.aborted, false);
  task.resolve();
  await second.completion;
  assert.equal(calls, 1);
  await runner.close();
});

test("last queued owner cancellation removes the task before it can run", async () => {
  const blocker = deferred();
  const started: string[] = [];
  const runner = new KeyedDerivationRunner({ name: "queued", maxConcurrency: () => 1,
    async run(key) { started.push(key); if (key === "block") await blocker.promise; }
  });
  const head = runner.acquire(["block"]);
  const waiting = runner.acquire(["cancel"]);
  waiting.release(new Error("discarded"));
  await assert.rejects(waiting.completion, /discarded/);
  blocker.resolve();
  await head.completion;
  assert.deepEqual(started, ["block"]);
  await runner.close();
});

test("cancelled running work holds its physical slot and old finally cannot erase a replacement", async () => {
  const oldTask = deferred();
  const nextTask = deferred();
  const started: string[] = [];
  let oldSignal!: AbortSignal;
  const runner = new KeyedDerivationRunner({ name: "replacement", maxConcurrency: () => 1,
    async run(key, signal) {
      started.push(key);
      if (started.length === 1) { oldSignal = signal; await oldTask.promise; }
      else await nextTask.promise;
    }
  });
  const old = runner.acquire(["same"]);
  old.release();
  await assert.rejects(old.completion);
  assert.equal(oldSignal.aborted, true);
  const fresh = runner.acquire(["same"]);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(started.length, 1, "ignoring cancellation does not release the execution slot");
  oldTask.resolve();
  await waitFor(() => started.length === 2);
  const sharedFresh = runner.acquire(["same"]);
  nextTask.resolve();
  await Promise.all([fresh.completion, sharedFresh.completion]);
  assert.equal(started.length, 2);
  await runner.close();
});

test("batch admission is atomic and bounded while existing work may still be shared", async () => {
  const blocked = deferred();
  const started: string[] = [];
  const runner = new KeyedDerivationRunner({ name: "capacity", maxConcurrency: () => 1, maxTasks: 2,
    async run(key) { started.push(key); await blocked.promise; }
  });
  const first = runner.acquire(["one"]);
  assert.throws(() => runner.acquire(["two", "three"]), DerivationQueueFullError);
  const second = runner.acquire(["two"]);
  const shared = runner.acquire(["one"]);
  assert.throws(() => runner.acquire(["three"]), error => (error as { code: string }).code === "DERIVATION_QUEUE_FULL");
  blocked.resolve();
  await Promise.all([first.completion, second.completion, shared.completion]);
  assert.deepEqual(started, ["one", "two"]);
  await runner.close();
});

test("already-aborted acquisition does not enqueue work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before admission"));
  let calls = 0;
  const runner = new KeyedDerivationRunner({ name: "preabort", maxConcurrency: () => 1, async run() { calls++; } });
  assert.throws(() => runner.acquire(["a"], { abortSignal: controller.signal }), /cancelled before admission/);
  assert.equal(calls, 0);
  await runner.close();
});

test("failed workers settle their owners, log once and leave the queue usable", async () => {
  const warnings: unknown[] = [];
  const completed: string[] = [];
  const runner = new KeyedDerivationRunner({ name: "failure", maxConcurrency: () => 1,
    async run(key) { if (key === "bad") throw new Error("synthetic failure"); completed.push(key); },
    logger: { debug() {}, warn(value: unknown) { warnings.push(value); } }
  });
  const lease = runner.acquire(["bad", "good"]);
  await lease.completion;
  assert.equal(warnings.length, 1);
  assert.deepEqual(completed, ["good"]);
  await runner.close();
});

test("invalid concurrency falls back to one physical worker", async () => {
  let active = 0;
  let peak = 0;
  const runner = new KeyedDerivationRunner({ name: "concurrency", maxConcurrency: () => Number.NaN,
    async run() { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; }
  });
  await runner.acquire(["one", "two", "three"]).completion;
  assert.equal(peak, 1);
  await runner.close();
});

test("close cancels all owners, drops queued work and waits for actual running cleanup", async () => {
  const cleanup = deferred();
  const started: string[] = [];
  let signal!: AbortSignal;
  const runner = new KeyedDerivationRunner({ name: "shutdown", maxConcurrency: () => 1,
    async run(key, input) { started.push(key); signal = input; await cleanup.promise; }
  });
  const lease = runner.acquire(["active", "queued"]);
  let closed = false;
  const close = runner.close().then(() => { closed = true; });
  await assert.rejects(lease.completion, /已关闭/);
  assert.equal(signal.aborted, true);
  assert.equal(closed, false);
  assert.throws(() => runner.acquire(["late"]), /已关闭/);
  cleanup.resolve();
  await close;
  await runner.close();
  assert.deepEqual(started, ["active"]);
});

test("repeated cancelled shared owners unregister notifications and settle their own item promises", async () => {
  const pending = deferred();
  const runner = new KeyedDerivationRunner({ name: "lease-cleanup", maxConcurrency: () => 1, async run() { await pending.promise; } });
  const retained = runner.acquire(["shared"]);
  for (let index = 0; index < 2000; index++) {
    const request = runner.acquire(["shared"]);
    const item = request.completed.get("shared")!;
    request.release(new Error("cancel request"));
    await assert.rejects(request.completion, /cancel request/);
    await assert.rejects(item, /cancel request/);
  }
  const internal = runner as unknown as { entries: Map<string, { owners: Map<symbol, () => void> }>; leases: Set<unknown> };
  assert.equal(internal.entries.get("shared")!.owners.size, 1);
  assert.equal(internal.leases.size, 1);
  pending.resolve();
  await retained.completion;
  await runner.close();
});
