import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { MessageQueue } from "../../src/conversation/messageQueue.ts";
import { createGenerationOutbound } from "../../src/app/generation/generationOutbound.ts";
import { DeliveryCoordinator } from "../../src/services/messaging/deliveryCoordinator.ts";
import { QqReplyPermitRegistry } from "../../src/services/qqOfficial/replyPermit.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("official routing rejects missing or cross-target permits without touching OneBot", async () => {
  let writes = 0;
  const oneBot = { sendText() { writes++; } } as never;
  const official = { async sendText() { writes++; return { messageId: "opaque", connectionId: "qq_official.app" }; } } as never;
  const messaging = new DeliveryCoordinator(oneBot, official);
  const registry = new QqReplyPermitRegistry("qq_official.app");
  const permit = registry.issue({ chatType: "group", targetId: "group", messageId: "incoming", timestampMs: Date.now() });
  await assert.rejects(messaging.sendText({ sessionId: "qq_official.app:g:group" }, "text"));
  await assert.rejects(messaging.sendText({ sessionId: "qq_official.app:g:other", replyContext: permit }, "text"));
  await assert.rejects(messaging.sendText({ sessionId: "qq_official.other:g:group", replyContext: permit }, "text"));
  assert.equal(writes, 0);
  assert.deepEqual(await messaging.sendText({ sessionId: "qq_official.app:g:group", replyContext: permit }, "text"), {
    platform: "qq_official", connectionId: "qq_official.app", messageId: "opaque"
  });
  assert.equal(writes, 1);
});

test("native stream persists a single accepted body and does not replay its final summary", async () => {
  const config = createTestAppConfig();
  const sessionManager = new SessionManager(config);
  const sessionId = "qq_official.app:p:user";
  sessionManager.ensureSession({ id: sessionId, type: "private", source: "qq_official" });
  const started = sessionManager.beginSyntheticGeneration(sessionId);
  const registry = new QqReplyPermitRegistry("qq_official.app");
  const permit = registry.issue({ chatType: "private", targetId: "user", messageId: "incoming", timestampMs: Date.now() });
  let body = "";
  let finishes = 0;
  const official = {
    openTextStream() {
      return {
        append(delta: string) { body += delta; },
        async finish() { finishes++; return { acceptedText: body, messageId: "stream-id", connectionId: "qq_official.app" }; },
        async interrupt() { return null; }
      };
    }
  } as never;
  const logger = pino({ level: "silent" });
  const oneBot = {} as never;
  const outbound = createGenerationOutbound({ logger, sessionManager, messageQueue: new MessageQueue(logger, config), oneBotClient: oneBot,
    messaging: new DeliveryCoordinator(oneBot, official), persistSession() {} }, {
    sessionId, responseEpoch: started.responseEpoch, abortController: started.abortController, responseAbortController: started.responseAbortController,
    sendTarget: { delivery: "qq_official", chatType: "private", userId: "user", senderName: "用户", replyContext: permit }
  });
  outbound.appendNativeDelta("你好");
  outbound.appendNativeDelta(" 世界");
  await outbound.enqueueChunk("你好 世界");
  await outbound.finishStream();
  assert.equal(body, "你好 世界");
  assert.equal(finishes, 1);
  const messages = sessionManager.getLlmVisibleHistory(sessionId).filter(item => item.role === "assistant");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.content, "你好 世界");
});

test("explicit humanized native pacing buffers deltas and cancellation prevents the first platform write", { timeout: 2000 }, async () => {
  const config = createTestAppConfig({ conversation: { outbound: { baseDelayMs: 60_000, charDelayMs: 0, maxDelayMs: 60_000, randomFactorMin: 1, randomFactorMax: 1 } } });
  const manager = new SessionManager(config);
  const sessionId = "qq_official.app:p:user";
  manager.ensureSession({ id: sessionId, type: "private", source: "qq_official" });
  manager.getSession(sessionId).pacingPreferences.outbound = "humanized";
  const started = manager.beginSyntheticGeneration(sessionId);
  const waiting = deferred();
  const logger = pino({ level: "silent" });
  logger.debug = ((_data: unknown, event: string) => { if (event === "outbound_delay_scheduled") waiting.resolve(); }) as typeof logger.debug;
  let opened = 0;
  const official = { openTextStream() { opened++; throw new Error("must not submit"); } } as never;
  const oneBot = {} as never;
  const outbound = createGenerationOutbound({ logger, sessionManager: manager, messageQueue: new MessageQueue(logger, config),
    oneBotClient: oneBot, messaging: new DeliveryCoordinator(oneBot, official), persistSession() {} }, {
    sessionId, responseEpoch: started.responseEpoch, abortController: started.abortController, responseAbortController: started.responseAbortController,
    sendTarget: { delivery: "qq_official", chatType: "private", userId: "user", senderName: "用户" }
  });
  outbound.appendNativeDelta("仍在本地");
  outbound.appendNativeDelta("继续生成不阻塞");
  await waiting.promise;
  manager.interruptOutbound(sessionId);
  await outbound.interruptStream();
  assert.equal(opened, 0);
});

test("Web delivery honors its saved humanized pacing rather than forcing immediate", { timeout: 2000 }, async () => {
  const config = createTestAppConfig({ conversation: { outbound: { baseDelayMs: 60_000, charDelayMs: 0, maxDelayMs: 60_000, randomFactorMin: 1, randomFactorMax: 1 } } });
  const manager = new SessionManager(config);
  const sessionId = "web:test";
  manager.ensureSession({ id: sessionId, type: "private", source: "web" });
  manager.getSession(sessionId).pacingPreferences.outbound = "humanized";
  const started = manager.beginSyntheticGeneration(sessionId);
  const waiting = deferred();
  const logger = pino({ level: "silent" });
  logger.debug = ((data: { waitMs?: number }, event: string) => { if (event === "outbound_delay_scheduled" && (data.waitMs ?? 0) > 0) waiting.resolve(); }) as typeof logger.debug;
  let committed = false;
  const outbound = createGenerationOutbound({ logger, sessionManager: manager, messageQueue: new MessageQueue(logger, config), oneBotClient: {} as never, persistSession() {} }, {
    sessionId, responseEpoch: started.responseEpoch, abortController: started.abortController, responseAbortController: started.responseAbortController,
    sendTarget: { delivery: "web", chatType: "private", userId: "user", senderName: "用户" }, committedTextSink: { commitText() { committed = true; } }
  });
  const pending = outbound.enqueueChunk("等待发送");
  await waiting.promise;
  manager.interruptOutbound(sessionId);
  assert.equal(await pending, false);
  assert.equal(committed, false);
});

test("a media queue task can seal a newly buffered stream without waiting on its own queue", { timeout: 2000 }, async () => {
  const config = createTestAppConfig();
  const manager = new SessionManager(config);
  const sessionId = "qq_official.app:p:user";
  manager.ensureSession({ id: sessionId, type: "private", source: "qq_official" });
  const started = manager.beginSyntheticGeneration(sessionId);
  const registry = new QqReplyPermitRegistry("qq_official.app");
  const permit = registry.issue({ chatType: "private", targetId: "user", messageId: "incoming", timestampMs: Date.now() });
  const order: string[] = [];
  const official = { openTextStream() { return {
    append() { order.push("text"); },
    async finish() { order.push("seal"); return null; },
    async interrupt() { return null; }
  }; } } as never;
  const logger = pino({ level: "silent" });
  const queue = new MessageQueue(logger, config);
  const oneBot = {} as never;
  const outbound = createGenerationOutbound({ logger, sessionManager: manager, messageQueue: queue, oneBotClient: oneBot,
    messaging: new DeliveryCoordinator(oneBot, official), persistSession() {} }, {
    sessionId, responseEpoch: started.responseEpoch, abortController: started.abortController, responseAbortController: started.responseAbortController,
    sendTarget: { delivery: "qq_official", chatType: "private", userId: "user", senderName: "用户", replyContext: permit }
  });
  const entered = deferred();
  const proceed = deferred();
  const media = queue.enqueue(sessionId, async () => {
    entered.resolve();
    await proceed.promise;
    await outbound.finishStream();
    order.push("media");
  });
  await entered.promise;
  outbound.appendNativeDelta("文字");
  proceed.resolve();
  await media;
  assert.deepEqual(order, ["text", "seal", "media"]);
});

test("an unknown native seal result reports failure and retains the confirmed accepted prefix", async () => {
  const { QqDeliveryError } = await import("../../src/services/qqOfficial/types.ts");
  const config = createTestAppConfig();
  const manager = new SessionManager(config);
  const sessionId = "qq_official.app:p:user";
  manager.ensureSession({ id: sessionId, type: "private", source: "qq_official" });
  const started = manager.beginSyntheticGeneration(sessionId);
  const permit = new QqReplyPermitRegistry("qq_official.app").issue({ chatType: "private", targetId: "user", messageId: "incoming", timestampMs: Date.now() });
  const accepted = { acceptedText: "平台已接受", messageId: "opaque-id", connectionId: "qq_official.app" };
  const official = { openTextStream() { return {
    receipt: accepted, append() {}, async finish() { throw new QqDeliveryError("unknown", "timeout"); }, async interrupt() { return accepted; }
  }; } } as never;
  const failures: string[] = [];
  const logger = pino({ level: "silent" });
  const oneBot = {} as never;
  const outbound = createGenerationOutbound({ logger, sessionManager: manager, messageQueue: new MessageQueue(logger, config), oneBotClient: oneBot,
    messaging: new DeliveryCoordinator(oneBot, official, (_address, status) => failures.push(status)), persistSession() {} }, {
    sessionId, responseEpoch: started.responseEpoch, abortController: started.abortController, responseAbortController: started.responseAbortController,
    sendTarget: { delivery: "qq_official", chatType: "private", userId: "user", senderName: "用户", replyContext: permit }
  });
  outbound.appendNativeDelta("平台已接受以及未确认的文字");
  await assert.rejects(outbound.finishStream());
  assert.deepEqual(failures, ["unknown"]);
  const history = manager.getLlmVisibleHistory(sessionId).map(item => item.content).join("\n");
  assert.equal(history, "平台已接受");
});

test("abort upgrades a normal seal already scheduled in the same tick", { timeout: 2000 }, async () => {
  const config = createTestAppConfig();
  const manager = new SessionManager(config);
  const sessionId = "qq_official.app:p:user";
  manager.ensureSession({ id: sessionId, type: "private", source: "qq_official" });
  const started = manager.beginSyntheticGeneration(sessionId);
  const permit = new QqReplyPermitRegistry("qq_official.app").issue({ chatType: "private", targetId: "user", messageId: "incoming", timestampMs: Date.now() });
  let interrupted = false;
  let unsentFlushed = false;
  const official = { openTextStream() { return {
    receipt: null, append() {},
    async finish() { if (!interrupted) unsentFlushed = true; return null; },
    async interrupt() { interrupted = true; return null; }
  }; } } as never;
  const logger = pino({ level: "silent" });
  const queue = new MessageQueue(logger, config);
  const oneBot = {} as never;
  const outbound = createGenerationOutbound({ logger, sessionManager: manager, messageQueue: queue, oneBotClient: oneBot,
    messaging: new DeliveryCoordinator(oneBot, official), persistSession() {} }, {
    sessionId, responseEpoch: started.responseEpoch, abortController: started.abortController, responseAbortController: started.responseAbortController,
    sendTarget: { delivery: "qq_official", chatType: "private", userId: "user", senderName: "用户", replyContext: permit }
  });
  outbound.appendNativeDelta("本地待提交");
  await queue.getDrainPromise(`native-stream-start:${sessionId}`);
  // Let the start promise's finally run before sealing, then abort before its microtask submits pending text.
  await Promise.resolve();
  const closing = outbound.finishStream();
  manager.interruptOutbound(sessionId);
  await closing;
  assert.equal(interrupted, true);
  assert.equal(unsentFlushed, false);
});
