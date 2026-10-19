import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import pino from "pino";
import { ContextExtractionQueue } from "../../src/context/contextExtractionQueue.ts";
import type { ContextExtractionTurn } from "../../src/context/contextExtractionService.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function createTurn(input: {
  sessionId: string;
  userId: string;
  text: string;
  receivedAt: number;
}): ContextExtractionTurn {
  return {
    sessionId: input.sessionId,
    userId: input.userId,
    chatType: "group",
    senderName: input.userId,
    userMessages: [{
      userId: input.userId,
      senderName: input.userId,
      text: input.text,
      receivedAt: input.receivedAt
    }],
    assistantText: "好的",
    completedAt: input.receivedAt + 1
  };
}

test("ContextExtractionQueue isolates pending batches by session and user", async () => {
  const calls: Array<{ sessionId: string; userId: string; texts: string[] }> = [];
  const processed: Array<{ sessionId: string; userId: string; created: number; turns: number }> = [];
  const queue = new ContextExtractionQueue(
    createTestAppConfig({
      context: {
        extraction: {
          enabled: true,
          debounceMs: 1,
          maxDelayMs: 10,
          maxTurnsPerBatch: 3,
          minConfidence: 0.7,
          relatedMemoryLimit: 8,
          timeoutMs: 1000,
          enableThinking: false
        }
      }
    }),
    {
      async processTurns(input) {
        calls.push({
          sessionId: input.sessionId,
          userId: input.userId,
          texts: input.turns.flatMap((turn) => turn.userMessages.map((message) => message.text))
        });
        return { created: 0, replaced: 0, ignored: 0, items: [] };
      }
    },
    pino({ level: "silent" }),
    {
      onBatchProcessed(event) {
        processed.push({
          sessionId: event.sessionId,
          userId: event.userId,
          created: event.result.created,
          turns: event.turns.length
        });
      }
    }
  );

  queue.enqueueTurn(createTurn({
    sessionId: "qqbot:g:group_1",
    userId: "user_a",
    text: "记住我喜欢黑咖啡",
    receivedAt: 100
  }));
  queue.enqueueTurn(createTurn({
    sessionId: "qqbot:g:group_1",
    userId: "user_b",
    text: "记住我喜欢绿茶",
    receivedAt: 101
  }));

  await sleep(30);
  queue.stop();

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls
      .map((call) => ({ userId: call.userId, texts: call.texts }))
      .sort((left, right) => left.userId.localeCompare(right.userId)),
    [
      { userId: "user_a", texts: ["记住我喜欢黑咖啡"] },
      { userId: "user_b", texts: ["记住我喜欢绿茶"] }
    ]
  );
  assert.deepEqual(
    processed
      .map((event) => ({ userId: event.userId, created: event.created, turns: event.turns }))
      .sort((left, right) => left.userId.localeCompare(right.userId)),
    [
      { userId: "user_a", created: 0, turns: 1 },
      { userId: "user_b", created: 0, turns: 1 }
    ]
  );
});

test("ContextExtractionQueue reports failed extraction batches", async () => {
  const failed: Array<{ sessionId: string; userId: string; error: string; turns: number }> = [];
  const queue = new ContextExtractionQueue(
    createTestAppConfig({
      context: {
        extraction: {
          enabled: true,
          debounceMs: 1,
          maxDelayMs: 10,
          maxTurnsPerBatch: 3,
          minConfidence: 0.7,
          relatedMemoryLimit: 8,
          timeoutMs: 1000,
          enableThinking: false
        }
      }
    }),
    {
      async processTurns() {
        throw new Error("extractor unavailable");
      }
    },
    pino({ level: "silent" }),
    {
      onBatchFailed(event) {
        failed.push({
          sessionId: event.sessionId,
          userId: event.userId,
          error: event.error instanceof Error ? event.error.message : String(event.error),
          turns: event.turns.length
        });
      }
    }
  );

  queue.enqueueTurn(createTurn({
    sessionId: "qqbot:p:user_a",
    userId: "user_a",
    text: "记住我喜欢黑咖啡",
    receivedAt: 100
  }));

  await sleep(30);
  queue.stop();

  assert.deepEqual(failed, [{
    sessionId: "qqbot:p:user_a",
    userId: "user_a",
    error: "extractor unavailable",
    turns: 1
  }]);
});

test("ContextExtractionQueue cancels pending batches for a deleted session", async () => {
  const calls: string[] = [];
  const queue = new ContextExtractionQueue(
    createTestAppConfig({
      context: {
        extraction: {
          enabled: true,
          debounceMs: 30,
          maxDelayMs: 100,
          maxTurnsPerBatch: 3,
          minConfidence: 0.7,
          relatedMemoryLimit: 8,
          timeoutMs: 1000,
          enableThinking: false
        }
      }
    }),
    {
      async processTurns(input) {
        calls.push(input.sessionId);
        return { created: 0, replaced: 0, ignored: 0, items: [] };
      }
    },
    pino({ level: "silent" })
  );

  queue.enqueueTurn(createTurn({
    sessionId: "qqbot:p:user_a",
    userId: "user_a",
    text: "记住这条即将被取消的会话记忆",
    receivedAt: 100
  }));
  queue.enqueueTurn(createTurn({
    sessionId: "qqbot:p:user_b",
    userId: "user_b",
    text: "记住这条仍然应该被抽取的会话记忆",
    receivedAt: 101
  }));

  const cancelled = queue.cancelSession({ sessionId: "qqbot:p:user_a" });

  await sleep(80);
  queue.stop();

  assert.deepEqual(cancelled, {
    cancelledBatchCount: 1,
    cancelledTurnCount: 1
  });
  assert.deepEqual(calls, ["qqbot:p:user_b"]);
});

test("backlogged extraction drains every accepted turn in FIFO batches", async () => {
  const started = deferred();
  const release = deferred();
  const drained = deferred();
  const calls: string[][] = [];
  const queue = new ContextExtractionQueue(createTestAppConfig({ context: { extraction: {
    enabled: true, debounceMs: 1, maxDelayMs: 10, maxTurnsPerBatch: 2
  } } }), { async processTurns(input) {
    calls.push(input.turns.map((turn) => turn.userMessages[0]!.text));
    if (calls.length === 1) { started.resolve(); await release.promise; }
    if (calls.length === 4) drained.resolve();
    return { created: 0, replaced: 0, ignored: 0, items: [] };
  } }, pino({ level: "silent" }));
  try {
    queue.enqueueTurn(createTurn({ sessionId: "s", userId: "u", text: "0", receivedAt: 0 }));
    await Promise.race([started.promise, sleep(1000).then(() => { throw new Error("queue did not start"); })]);
    for (let i = 1; i <= 5; i++) queue.enqueueTurn(createTurn({ sessionId: "s", userId: "u", text: String(i), receivedAt: i }));
    release.resolve();
    await Promise.race([drained.promise, sleep(1000).then(() => { throw new Error("queue did not drain"); })]);
    assert.deepEqual(calls, [["0"], ["1", "2"], ["3", "4"], ["5"]]);
  } finally { release.resolve(); queue.stop(); }
});

test("session cancellation aborts in-flight extraction and suppresses its observer", async () => {
  const started = deferred();
  const release = deferred();
  let signal: AbortSignal | undefined;
  let processed = false;
  const queue = new ContextExtractionQueue(createTestAppConfig({ context: { extraction: {
    enabled: true, debounceMs: 1, maxDelayMs: 10
  } } }), { async processTurns(input) {
    signal = input.abortSignal; started.resolve(); await release.promise;
    return { created: 0, replaced: 0, ignored: 0, items: [] };
  } }, pino({ level: "silent" }), { onBatchProcessed() { processed = true; } });
  try {
    queue.enqueueTurn(createTurn({ sessionId: "s", userId: "u", text: "memory", receivedAt: 0 }));
    await Promise.race([started.promise, sleep(1000).then(() => { throw new Error("queue did not start"); })]);
    assert.deepEqual(queue.cancelSession({ sessionId: "s" }), { cancelledBatchCount: 1, cancelledTurnCount: 1 });
    assert.equal(signal?.aborted, true);
    release.resolve(); await sleep(0);
    assert.equal(processed, false);
  } finally { release.resolve(); queue.stop(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("global extraction capacity stays occupied until cancelled work settles and ready keys are fair", async () => {
  const releases = [deferred(), deferred(), deferred()];
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  const queue = new ContextExtractionQueue(createTestAppConfig({ context: { extraction: {
    maxConcurrency: 2, maxTurnsPerBatch: 1, debounceMs: 1
  } } }), { async processTurns(input) {
    const index = calls.length;
    calls.push(input.sessionId);
    peak = Math.max(peak, ++active);
    try { await releases[index]?.promise; } finally { active--; }
    if (index === 0) throw new Error("synthetic failure");
    return { created: 0, replaced: 0, ignored: 0, items: [] };
  } }, pino({ level: "silent" }));
  const enqueue = (id: string) => queue.enqueueTurn(createTurn({ sessionId: id, userId: "u", text: "memory", receivedAt: 0 }));
  try {
    enqueue("a"); enqueue("b");
    await sleep(20);
    assert.deepEqual(calls, ["a", "b"]);
    enqueue("a"); enqueue("c"); enqueue("removed");
    await sleep(20);
    queue.cancelSession({ sessionId: "removed" });
    queue.cancelSession({ sessionId: "b" });
    assert.deepEqual(calls, ["a", "b"]);
    releases[0]!.resolve(); await sleep(20);
    assert.deepEqual(calls, ["a", "b", "c"]);
    releases[1]!.resolve(); await sleep(20);
    assert.deepEqual(calls, ["a", "b", "c", "a"]);
    assert.equal(peak, 2);
    queue.stop(); releases[2]!.resolve(); await sleep(20);
    assert.equal(calls.includes("removed"), false);
  } finally { queue.stop(); releases.forEach((release) => release.resolve()); }
});

test("stopping a saturated extraction queue prevents ready batches from starting", async () => {
  const release = deferred();
  const calls: string[] = [];
  const queue = new ContextExtractionQueue(createTestAppConfig({ context: { extraction: {
    maxConcurrency: 1, maxTurnsPerBatch: 1
  } } }), { async processTurns(input) {
    calls.push(input.sessionId); await release.promise;
    return { created: 0, replaced: 0, ignored: 0, items: [] };
  } }, pino({ level: "silent" }));
  try {
    for (const id of ["a", "b"]) queue.enqueueTurn(createTurn({ sessionId: id, userId: "u", text: "memory", receivedAt: 0 }));
    await sleep(20); queue.stop(); release.resolve(); await sleep(20);
    assert.deepEqual(calls, ["a"]);
  } finally { queue.stop(); release.resolve(); }
});

test("config reload resumes paused ready batches", async () => {
  const config = createTestAppConfig({ context: { extraction: { maxConcurrency: 1, maxTurnsPerBatch: 1 } } });
  const release = deferred();
  const calls: string[] = [];
  const queue = new ContextExtractionQueue(config, { async processTurns(input) {
    calls.push(input.sessionId);
    if (input.sessionId === "a") await release.promise;
    return { created: 0, replaced: 0, ignored: 0, items: [] };
  } }, pino({ level: "silent" }));
  try {
    for (const id of ["a", "b"]) queue.enqueueTurn(createTurn({ sessionId: id, userId: "u", text: "memory", receivedAt: 0 }));
    await sleep(20);
    config.context.extraction.enabled = false;
    release.resolve(); await sleep(20);
    assert.deepEqual(calls, ["a"]);
    config.context.extraction.enabled = true; queue.reloadConfig(); await sleep(20);
    assert.deepEqual(calls, ["a", "b"]);
  } finally { queue.stop(); release.resolve(); }
});


test("raising extraction concurrency starts waiting work without waiting for in-flight completion", async () => {
  const config = createTestAppConfig({ context: { extraction: { maxConcurrency: 1, maxTurnsPerBatch: 1 } } });
  const release = deferred();
  const calls: string[] = [];
  const queue = new ContextExtractionQueue(config, { async processTurns(input) {
    calls.push(input.sessionId); await release.promise;
    return { created: 0, replaced: 0, ignored: 0, items: [] };
  } }, pino({ level: "silent" }));
  try {
    for (const id of ["a", "b"]) queue.enqueueTurn(createTurn({ sessionId: id, userId: "u", text: "memory", receivedAt: 0 }));
    await sleep(20); assert.deepEqual(calls, ["a"]);
    config.context.extraction.maxConcurrency = 2; queue.reloadConfig();
    assert.deepEqual(calls, ["a", "b"]);
  } finally { queue.stop(); release.resolve(); }
});
