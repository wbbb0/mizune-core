import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { MessageQueue } from "../../src/conversation/messageQueue.ts";
import { createGenerationOutbound } from "../../src/app/generation/generationOutbound.ts";
import { DeliveryCoordinator } from "../../src/services/messaging/deliveryCoordinator.ts";
import { QqReplyPermitRegistry } from "../../src/services/qqOfficial/replyPermit.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const delivery of ["qq_official", "onebot"] as const) {
  test(`clearing during ${delivery} text submission cannot restore history or sent-message references`, { timeout: 2000 }, async () => {
    const config = createTestAppConfig({ conversation: { outbound: { baseDelayMs: 0, charDelayMs: 0 } } });
    const manager = new SessionManager(config);
    const sessionId = delivery === "qq_official" ? "qq_official.app:p:user" : "bot:p:123";
    manager.ensureSession({ id: sessionId, type: "private", source: delivery });
    const started = manager.beginSyntheticGeneration(sessionId);
    const inFlight = deferred<void>();
    const release = deferred<void>();
    const receipt = { platform: "qq_official" as const, connectionId: "qq_official.app", chatType: "private" as const,
      targetId: "user", messageId: "accepted-id", acceptedText: "已经提交的正文", status: "accepted" as const, timestampMs: Date.now() };
    const oneBot = { async sendText() { inFlight.resolve(); await release.promise; return { data: { message_id: 42 } }; } } as never;
    const official = { openTextStream() { return {
      receipt: null, append() {},
      async finish() { inFlight.resolve(); await release.promise; return receipt; },
      async interrupt() { await release.promise; return receipt; }
    }; } } as never;
    const logger = pino({ level: "silent" });
    const queue = new MessageQueue(logger, config);
    const permit = new QqReplyPermitRegistry("qq_official.app").issue({ chatType: "private", targetId: "user", messageId: "incoming", timestampMs: Date.now() });
    const outbound = createGenerationOutbound({ logger, sessionManager: manager, messageQueue: queue, oneBotClient: oneBot,
      messaging: new DeliveryCoordinator(oneBot, official), persistSession() {} }, {
      sessionId, responseEpoch: started.responseEpoch, abortController: started.abortController, responseAbortController: started.responseAbortController,
      sendTarget: { delivery, chatType: "private", userId: delivery === "qq_official" ? "user" : "123", senderName: "用户", replyContext: permit }
    });
    let sending: Promise<unknown>;
    if (delivery === "qq_official") {
      outbound.appendNativeDelta("已经提交的正文");
      sending = outbound.finishStream();
    } else sending = outbound.enqueueChunk("已经提交的正文");
    await inFlight.promise;
    manager.clearSession(sessionId);
    release.resolve();
    await sending;
    assert.equal(manager.getSession(sessionId).internalTranscript.length, 0);
    assert.deepEqual(manager.getSession(sessionId).sentMessages, []);
    assert.equal(manager.getSession(sessionId).activeAssistantResponse, null);
  });
}
