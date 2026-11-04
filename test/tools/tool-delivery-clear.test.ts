import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { MessageQueue } from "../../src/conversation/messageQueue.ts";
import { setupDraftToolHandlers } from "../../src/llm/tools/conversation/setupDraftTools.ts";
import { debugToolHandlers } from "../../src/llm/tools/runtime/debugTools.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
for (const kind of ["setup", "debug"] as const) {
  test(`${kind} tool cannot restore a cleared session after an in-flight send returns`, { timeout: 2000 }, async () => {
    const config = createTestAppConfig({ conversation: { outbound: { baseDelayMs: 0, charDelayMs: 0 } } });
    const manager = new SessionManager(config);
    const sessionId = "bot:p:123";
    manager.ensureSession({ id: sessionId, type: "private", source: "onebot" });
    const started = manager.beginSyntheticGeneration(sessionId);
    const inFlight = deferred();
    const release = deferred();
    const queue = new MessageQueue(pino({ level: "silent" }), config);
    const context = {
      config, relationship: "owner", replyDelivery: "onebot", sessionManager: manager, messageQueue: queue,
      abortSignal: started.abortController.signal, outboundSignal: manager.getOutboundAbortSignal(sessionId),
      lastMessage: { sessionId, userId: "123", senderName: "用户" },
      messaging: { async sendText() { inFlight.resolve(); await release.promise; return { platform: "onebot", messageId: 42 }; } }
    } as unknown as BuiltinToolContext;
    const call = { id: "test", type: "function" as const, function: { name: kind === "setup" ? "send_setup_draft" : "dump_debug_literals", arguments: "{}" } };
    const executing = kind === "setup"
      ? setupDraftToolHandlers.send_setup_draft!(call, { content: "待确认草稿" }, context)
      : debugToolHandlers.dump_debug_literals!(call, { literals: ["history_summary", "current_batch"] }, context);
    await inFlight.promise;
    manager.clearSession(sessionId);
    release.resolve();
    await executing;
    await queue.getDrainPromise(sessionId);
    const session = manager.getSession(sessionId);
    assert.deepEqual(session.internalTranscript, []);
    assert.deepEqual(session.sentMessages, []);
    assert.deepEqual(session.debugMarkers, []);
  });
}
