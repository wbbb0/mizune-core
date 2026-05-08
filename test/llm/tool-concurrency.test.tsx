import test from "node:test";
import assert from "node:assert/strict";
import { analyzeBuiltinToolConcurrency } from "../../src/llm/tools/toolConcurrency.ts";
import { executeToolCallsWithDependencies } from "../../src/llm/toolExecutionScheduler.ts";
import type { LlmToolCall } from "../../src/llm/llmClient.ts";

test("builtin tool concurrency marks terminal end-turn as terminal barrier", () => {
  assert.deepEqual(analyzeBuiltinToolConcurrency(toolCall("end_turn_without_reply")), {
    kind: "terminal_barrier"
  });
});

test("builtin tool concurrency distinguishes terminal resources by resource id", () => {
  assert.deepEqual(analyzeBuiltinToolConcurrency(toolCall("terminal_read", { resource_id: "a" })), {
    kind: "parallel",
    reads: ["terminal:a"],
    writes: []
  });
  assert.deepEqual(analyzeBuiltinToolConcurrency(toolCall("terminal_write", { resource_id: "a", input: "x" })), {
    kind: "parallel",
    reads: [],
    writes: ["terminal:a"]
  });
});

test("resource wildcard keys conflict with specific keys", async () => {
  const events: string[] = [];
  const writer = createDeferred<string>();

  const run = executeToolCallsWithDependencies({
    calls: [
      toolCall("filesystem_search", { query: "needle" }),
      toolCall("filesystem_write", { path: "src/a.ts", content: "x" })
    ],
    analyze: analyzeBuiltinToolConcurrency,
    maxConcurrency: 2,
    execute: async call => {
      events.push(`start:${call.function.name}`);
      if (call.function.name === "filesystem_search") {
        return writer.promise;
      }
      return "write-result";
    }
  });

  await waitFor(() => events.includes("start:filesystem_search"));
  assert.equal(events.includes("start:filesystem_write"), false);

  writer.resolve("search-result");
  await run;
  assert.deepEqual(events, ["start:filesystem_search", "start:filesystem_write"]);
});

function toolCall(name: string, args: Record<string, unknown> = {}): LlmToolCall {
  return {
    id: `call-${name}`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

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
