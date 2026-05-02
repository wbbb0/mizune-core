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
        return { created: 0, replaced: 0, ignored: 0 };
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
