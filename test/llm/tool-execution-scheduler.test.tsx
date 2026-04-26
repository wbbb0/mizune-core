import test from "node:test";
import assert from "node:assert/strict";
import { executeToolCallsWithDependencies, type ToolExecutionEffect } from "../../src/llm/toolExecutionScheduler.ts";

interface TestCall {
  id: string;
  effect: ToolExecutionEffect;
}

test("tool dependency scheduler runs non-conflicting calls concurrently and returns original order", async () => {
  const events: string[] = [];
  const first = createDeferred<string>();
  const second = createDeferred<string>();

  const calls: TestCall[] = [
    { id: "first", effect: { kind: "parallel", reads: ["clock"], writes: [] } },
    { id: "second", effect: { kind: "parallel", reads: ["profile"], writes: [] } }
  ];

  const run = executeToolCallsWithDependencies({
    calls,
    analyze: call => call.effect,
    maxConcurrency: 2,
    execute: async call => {
      events.push(`start:${call.id}`);
      if (call.id === "first") {
        return first.promise;
      }
      return second.promise;
    }
  });

  await waitFor(() => events.length === 2);
  assert.deepEqual(events, ["start:first", "start:second"]);

  second.resolve("second-result");
  first.resolve("first-result");

  const results = await run;
  assert.deepEqual(results.map(result => result.result), ["first-result", "second-result"]);
});

test("tool dependency scheduler waits only for conflicting predecessors", async () => {
  const events: string[] = [];
  const writer = createDeferred<string>();
  const independent = createDeferred<string>();

  const calls: TestCall[] = [
    { id: "writer", effect: { kind: "parallel", writes: ["local_file:/tmp/a.txt"] } },
    { id: "reader", effect: { kind: "parallel", reads: ["local_file:/tmp/a.txt"] } },
    { id: "independent", effect: { kind: "parallel", reads: ["local_file:/tmp/b.txt"] } }
  ];

  const run = executeToolCallsWithDependencies({
    calls,
    analyze: call => call.effect,
    maxConcurrency: 3,
    execute: async call => {
      events.push(`start:${call.id}`);
      if (call.id === "writer") {
        const value = await writer.promise;
        events.push(`finish:${call.id}`);
        return value;
      }
      if (call.id === "independent") {
        const value = await independent.promise;
        events.push(`finish:${call.id}`);
        return value;
      }
      events.push(`finish:${call.id}`);
      return "reader-result";
    }
  });

  await waitFor(() => events.includes("start:writer") && events.includes("start:independent"));
  assert.equal(events.includes("start:reader"), false);

  independent.resolve("independent-result");
  await waitFor(() => events.includes("finish:independent"));
  assert.equal(events.includes("start:reader"), false);

  writer.resolve("writer-result");
  await waitFor(() => events.includes("start:reader"));

  const results = await run;
  assert.deepEqual(results.map(result => result.call.id), ["writer", "reader", "independent"]);
});

test("tool dependency scheduler stops scheduling calls after a terminal result", async () => {
  const events: string[] = [];

  const calls: TestCall[] = [
    { id: "before", effect: { kind: "parallel", reads: ["time"] } },
    { id: "terminal", effect: { kind: "terminal_barrier" } },
    { id: "after", effect: { kind: "parallel", reads: ["profile"] } }
  ];

  const results = await executeToolCallsWithDependencies({
    calls,
    analyze: call => call.effect,
    maxConcurrency: 3,
    isTerminalResult: result => result === "terminal-result",
    execute: async call => {
      events.push(`start:${call.id}`);
      return `${call.id}-result`;
    }
  });

  assert.deepEqual(events, ["start:before", "start:terminal"]);
  assert.deepEqual(results.map(result => result.call.id), ["before", "terminal"]);
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail("condition was not met");
}
