import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createGenerationFailureLifecycle } from "../../src/app/generation/generationFailureLifecycle.ts";

const logger = pino({ level: "silent" });

test("failure reporting isolates diagnostic persistence and attempts notification once", async () => {
  let records = 0;
  let notifications = 0;
  const lifecycle = createGenerationFailureLifecycle({ logger, sessionId: "test", isCurrent: () => true,
    record() { records++; throw new Error("disk unavailable"); } });
  const notify = async () => { notifications++; throw new Error("transport unavailable"); };
  await lifecycle.report(new Error("prepare unavailable"), notify);
  await lifecycle.report(new Error("notification unavailable"), notify);
  assert.equal(records, 1);
  assert.equal(notifications, 1);
});

test("cancelled or superseded responses do not report or send, including cancellation during persistence", async () => {
  let current = false;
  let records = 0;
  let notifications = 0;
  const lifecycle = createGenerationFailureLifecycle({ logger, sessionId: "test", isCurrent: () => current,
    record() { records++; current = false; } });
  await lifecycle.report(new Error("stale"), async () => { notifications++; });
  assert.equal(records, 0);
  current = true;
  await lifecycle.report(new Error("failed"), async () => { notifications++; });
  assert.equal(records, 1);
  assert.equal(notifications, 0);
});
