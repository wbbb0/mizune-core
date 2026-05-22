import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createLogger } from "../../src/logger.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import {
  RECENT_ERROR_LIMIT,
  RecentErrorCapture,
  RecentErrorStore
} from "../../src/runtime/recentErrorStore.ts";

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-recent-errors-test-"));
  const logger = pino({ level: "silent" });
  const store = new RecentErrorStore(dataDir, logger);
  await store.init();
  return {
    dataDir,
    store,
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

test("RecentErrorStore keeps the latest fifty errors in sqlite", async () => {
  const harness = await createHarness();
  try {
    for (let index = 0; index < RECENT_ERROR_LIMIT + 3; index += 1) {
      harness.store.record({
        level: "error",
        capturedAtMs: index + 1,
        event: "event",
        message: `error-${index}`,
        context: { sessionId: `s-${index}` }
      });
    }

    const records = await harness.store.listRecent(100);
    assert.equal(records.length, RECENT_ERROR_LIMIT);
    assert.equal(records[0]?.message, "error-52");
    assert.equal(records.at(-1)?.message, "error-3");
  } finally {
    await harness.cleanup();
  }
});

test("RecentErrorStore lists recent errors as paged data rows", async () => {
  const harness = await createHarness();
  try {
    harness.store.record({
      level: "error",
      capturedAtMs: 1,
      event: "older_error",
      message: "older",
      context: { sessionId: "older-session" }
    });
    harness.store.record({
      level: "fatal",
      capturedAtMs: 2,
      event: "newer_error",
      message: "newer",
      errorName: "Error",
      stack: "Error: newer",
      context: { sessionId: "newer-session" }
    });

    const page = await harness.store.listRows({ offset: 0, limit: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.offset, 0);
    assert.equal(page.limit, 1);
    assert.deepEqual(page.rows, [{
      id: 2,
      capturedAtMs: 2,
      level: "fatal",
      event: "newer_error",
      message: "newer",
      errorName: "Error",
      stack: "Error: newer",
      context: { sessionId: "newer-session" }
    }]);
  } finally {
    await harness.cleanup();
  }
});

test("RecentErrorCapture buffers logger errors until store is bound", async () => {
  const harness = await createHarness();
  try {
    const capture = new RecentErrorCapture();
    const logger = createLogger(createTestAppConfig({ logLevel: "error" }), {
      recentErrorSink: (input) => capture.record(input)
    });

    logger.error({ err: new Error("boom"), sessionId: "session-1" }, "generation_failed");
    capture.bind(harness.store);

    const records = await harness.store.listRecent(1);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.event, "generation_failed");
    assert.equal(records[0]?.message, "boom");
    assert.equal(records[0]?.errorName, "Error");
    assert.match(records[0]?.stack ?? "", /boom/);
    assert.deepEqual(records[0]?.context, { sessionId: "session-1" });
  } finally {
    await harness.cleanup();
  }
});

test("logger hook captures fatal logs and does not throw when sink fails", async () => {
  const capture = new RecentErrorCapture();
  const logger = createLogger(createTestAppConfig({ logLevel: "fatal" }), {
    recentErrorSink: () => {
      throw new Error("sink failed");
    }
  });

  assert.doesNotThrow(() => {
    logger.fatal({ error: new Error("fatal boom") }, "startup_failed");
  });

  const harness = await createHarness();
  try {
    const fatalLogger = createLogger(createTestAppConfig({ logLevel: "fatal" }), {
      recentErrorSink: (input) => capture.record(input)
    });
    fatalLogger.fatal({ error: new Error("fatal boom") }, "startup_failed");
    capture.bind(harness.store);

    const records = await harness.store.listRecent(1);
    assert.equal(records[0]?.level, "fatal");
    assert.equal(records[0]?.event, "startup_failed");
    assert.equal(records[0]?.message, "fatal boom");
  } finally {
    await harness.cleanup();
  }
});

test("RecentErrorStore init is safe to call concurrently", async () => {
  const harness = await createHarness();
  try {
    await Promise.all([
      harness.store.init(),
      harness.store.init(),
      harness.store.formatRecent(1, "Asia/Shanghai")
    ]);
    assert.deepEqual(await harness.store.listRecent(1), []);
  } finally {
    await harness.cleanup();
  }
});

test("RecentErrorStore formats a compact readable report", async () => {
  const harness = await createHarness();
  try {
    harness.store.record({
      level: "fatal",
      capturedAtMs: 0,
      event: "startup_failed",
      message: "cannot boot",
      errorName: "Error",
      context: { statusCode: 500 }
    });

    const report = await harness.store.formatRecent(1, "Asia/Shanghai");
    assert.match(report, /最近 1 条报错/);
    assert.match(report, /FATAL startup_failed/);
    assert.match(report, /Error: cannot boot/);
    assert.match(report, /context: statusCode=500/);
  } finally {
    await harness.cleanup();
  }
});

test("RecentErrorStore caps formatted report size", async () => {
  const harness = await createHarness();
  try {
    for (let index = 0; index < RECENT_ERROR_LIMIT; index += 1) {
      harness.store.record({
        level: "error",
        capturedAtMs: index + 1,
        event: "large_error",
        message: "x".repeat(1_000),
        stack: "s".repeat(4_000)
      });
    }

    const report = await harness.store.formatRecent(RECENT_ERROR_LIMIT, "Asia/Shanghai");
    assert.equal(report.length <= 12_020, true);
    assert.match(report, /\[输出已截断\]/);
  } finally {
    await harness.cleanup();
  }
});
