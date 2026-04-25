import test from "node:test";
import assert from "node:assert/strict";
import { KeyedDerivationRunner } from "../../src/llm/derivations/keyedDerivationRunner.ts";

test("keyed derivation runner deduplicates queued and running keys", async () => {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const runner = new KeyedDerivationRunner({
    name: "test_runner",
    maxConcurrency: () => 1,
    async run(key) {
      started.push(key);
      await new Promise<void>((resolve) => {
        releases.set(key, resolve);
      });
    }
  });

  runner.enqueue(["a", "a", "b"]);
  runner.enqueue(["a", "b"]);

  await waitFor(() => started.length === 1);
  assert.deepEqual(started, ["a"]);
  assert.equal(runner.hasPendingOrRunning("a"), true);
  assert.equal(runner.hasPendingOrRunning("b"), true);

  releases.get("a")?.();
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ["a", "b"]);
  releases.get("b")?.();
  await runner.waitForCompletion("b");
});

test("keyed derivation runner respects max concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const runner = new KeyedDerivationRunner({
    name: "serial_runner",
    maxConcurrency: () => 1,
    async run() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active -= 1;
    }
  });

  runner.enqueue(["a", "b", "c"]);
  await Promise.all([
    runner.waitForCompletion("a"),
    runner.waitForCompletion("b"),
    runner.waitForCompletion("c")
  ]);

  assert.equal(maxActive, 1);
});

test("keyed derivation runner falls back to one worker for invalid concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const runner = new KeyedDerivationRunner({
    name: "invalid_concurrency_runner",
    maxConcurrency: () => Number.NaN,
    async run() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active -= 1;
    }
  });

  runner.enqueue(["a", "b"]);
  await Promise.all([
    runner.waitForCompletion("a"),
    runner.waitForCompletion("b")
  ]);

  assert.equal(maxActive, 1);
});

test("keyed derivation runner wait resolves after completion", async () => {
  const completed: string[] = [];
  const runner = new KeyedDerivationRunner({
    name: "wait_runner",
    maxConcurrency: () => 2,
    async run(key) {
      await delay(5);
      completed.push(key);
    }
  });

  runner.enqueue(["a"]);
  await runner.waitForCompletion("a");

  assert.deepEqual(completed, ["a"]);
  assert.equal(runner.hasPendingOrRunning("a"), false);
});

test("keyed derivation runner notifies waiters when worker fails", async () => {
  const warnings: unknown[] = [];
  const runner = new KeyedDerivationRunner({
    name: "failure_runner",
    maxConcurrency: () => 1,
    async run(key) {
      if (key === "bad") {
        throw new Error("boom");
      }
    },
    logger: {
      debug() {},
      warn(payload: unknown) {
        warnings.push(payload);
      }
    }
  });

  runner.enqueue(["bad", "good"]);
  await Promise.all([
    runner.waitForCompletion("bad"),
    runner.waitForCompletion("good")
  ]);

  assert.equal(warnings.length, 1);
  assert.equal(runner.hasPendingOrRunning("bad"), false);
  assert.equal(runner.hasPendingOrRunning("good"), false);
});

test("keyed derivation runner wait supports abort signals", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const runner = new KeyedDerivationRunner({
    name: "abort_runner",
    maxConcurrency: () => 1,
    async run() {}
  });

  await assert.rejects(
    () => runner.waitForCompletion("missing", controller.signal),
    /cancelled/
  );
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 500) {
      throw new Error("Timed out waiting for condition");
    }
    await delay(1);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
