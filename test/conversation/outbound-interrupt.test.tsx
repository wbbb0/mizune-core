import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { MessageQueue } from "../../src/conversation/messageQueue.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

  test("abort before any send skips all queued messages", async () => {
    const logger = pino({ level: "silent" });
    const queue = new MessageQueue(logger, createTestAppConfig({
      conversation: {
        outbound: {
          instantReply: true,
          randomFactorMin: 1,
          randomFactorMax: 1
        }
      }
    }));
    const abortController = new AbortController();
    const sent: string[] = [];

    // Abort immediately before enqueueing.
    abortController.abort();

    await queue.enqueueText({
      sessionId: "s1",
      text: "should not send",
      abortSignals: [abortController.signal],
      send: async () => {
        sent.push("should not send");
      }
    });

    assert.deepEqual(sent, []);
  });

  test("messages enqueued before abort complete; messages pending during abort are skipped", async () => {
    const logger = pino({ level: "silent" });
    const queue = new MessageQueue(logger, createTestAppConfig({
      conversation: {
        outbound: {
          instantReply: true,
          randomFactorMin: 1,
          randomFactorMax: 1
        }
      }
    }));
    const responseAbortController = new AbortController();
    const sent: string[] = [];

    // Enqueue first message that will send immediately (abort not fired yet).
    const p1 = queue.enqueueText({
      sessionId: "s1",
      text: "hi",
      abortSignals: [responseAbortController.signal],
      send: async () => {
        sent.push("msg1");
        // After msg1 sends, abort the controller - simulating user interrupt.
        responseAbortController.abort();
      }
    });

    // Enqueue second and third while msg1 is in the queue.
    queue.enqueueText({
      sessionId: "s1",
      text: "second message",
      abortSignals: [responseAbortController.signal],
      send: async () => {
        sent.push("msg2");
      }
    });

    queue.enqueueText({
      sessionId: "s1",
      text: "third message",
      abortSignals: [responseAbortController.signal],
      send: async () => {
        sent.push("msg3");
      }
    });

    // Wait for drain.
    await queue.getDrainPromise("s1");

    // Only msg1 should have been sent; msg2 and msg3 skipped because abort fired.
    assert.deepEqual(sent, ["msg1"]);
  });

  test("interruptOutbound aborts responseAbortController without cancelling generation", async () => {
    const { SessionManager } = await import("../../src/conversation/session/sessionManager.ts");
    const { createTestAppConfig } = await import("../helpers/config-fixtures.tsx");

    const config = createTestAppConfig();
    const sm = new SessionManager(config);
    sm.ensureSession({ id: "s1", type: "private" });
    const started = sm.beginSyntheticGeneration("s1");

    // interruptOutbound should only abort the response controller.
    const interrupted = sm.interruptOutbound("s1");
    assert.equal(interrupted, true);
    assert.equal(started.responseAbortController.signal.aborted, true);
    assert.equal(started.abortController.signal.aborted, false);

    // isResponding should still be true (generation continues).
    assert.equal(sm.isResponseOpen("s1", started.responseEpoch), true);
    assert.equal(sm.hasActiveResponse("s1"), true);

    // Second call is a no-op.
    assert.equal(sm.interruptOutbound("s1"), false);
  });
