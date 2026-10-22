import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { MessageQueue } from "../../src/conversation/messageQueue.ts";
import { createGenerationOutbound } from "../../src/app/generation/generationOutbound.ts";
import { createGenerationSegmentCoordinator } from "../../src/app/generation/generationSegmentCoordinator.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

for (const resume of [false, true]) {
  test(`steering wakes paced output and discards old text; resume tool loop=${resume}`, { timeout: 3000 }, async (t) => {
    const config = createTestAppConfig({ conversation: { outbound: {
      baseDelayMs: 0, charDelayMs: 0, maxDelayMs: 60_000, randomFactorMin: 1, randomFactorMax: 1
    } } });
    const sessionManager = new SessionManager(config);
    const sessionId = "qqbot:p:10001";
    sessionManager.ensureSession({ id: sessionId, type: "private", source: "onebot" });
    const started = sessionManager.beginSyntheticGeneration(sessionId);
    const originalMutationEpoch = sessionManager.getMutationEpoch(sessionId);
    t.after(() => started.abortController.abort());
    const logger = pino({ level: "silent" });
    let resolveWaiting!: () => void;
    const waiting = { promise: new Promise<void>(resolve => { resolveWaiting = resolve; }), resolve: () => resolveWaiting() };
    logger.debug = ((data: { waitMs?: number }, message: string) => {
      if (message === "outbound_delay_scheduled" && (data.waitMs ?? 0) > 0) waiting.resolve();
    }) as typeof logger.debug;
    const queue = new MessageQueue(logger, config);
    const sent: string[] = [];
    const outbound = createGenerationOutbound({
      logger, sessionManager, messageQueue: queue, persistSession() {},
      oneBotClient: {
        async sendText({ text }: { text: string }) {
          sent.push(text);
          return { data: { message_id: sent.length } };
        }
      } as never
    }, {
      sessionId, responseEpoch: started.responseEpoch,
      abortController: started.abortController, responseAbortController: started.responseAbortController,
      sendTarget: { delivery: "onebot", chatType: "private", userId: "10001", senderName: "用户" }
    });
    let draft = "";
    const coordinator = createGenerationSegmentCoordinator({
      disableStreamingSplit: true,
      committedSink: outbound,
      isOutputSuppressed: () => sessionManager.getOutboundAbortSignal(sessionId)?.aborted === true,
      draftStateSink: { replaceDraftText(text) { draft = text; }, clearDraftText() { draft = ""; } }
    });
    await coordinator.appendStandalone("已发第一段");
    config.conversation.outbound.baseDelayMs = 60_000;
    await coordinator.onTextDelta("未发第二段");
    const pending = coordinator.flushBufferedChunk();
    await waiting.promise;
    const queued = outbound.enqueueChunk("未发第三段");
    const oldOutputSignal = sessionManager.getOutboundAbortSignal(sessionId)!;
    sessionManager.interruptOutbound(sessionId);
    await Promise.all([pending, queued]);
    assert.deepEqual(sent, ["已发第一段"]);
    assert.equal(draft, "");
    assert.equal(started.abortController.signal.aborted, false);
    assert.equal(started.responseAbortController.signal.aborted, false);
    assert.equal(sessionManager.getMutationEpoch(sessionId), originalMutationEpoch);
    await coordinator.onTextDelta("旧请求剩余输出");
    await coordinator.flushSummary("已发第一段未发第二段旧请求剩余输出", true);
    assert.equal(draft, "");
    assert.deepEqual(sent, ["已发第一段"]);
    if (resume) {
      sessionManager.appendSteerMessage(sessionId, {
        chatType: "private", userId: "10001", senderName: "用户", text: "修改要求",
        images: [], imageIds: [], emojiSources: [], emojiIds: [], audioSources: [], audioIds: [],
        forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: false
      });
      assert.equal(sessionManager.consumeSteerMessages(sessionId).length, 1);
      await coordinator.discardPendingOutput();
      assert.equal(oldOutputSignal.aborted, true);
      assert.equal(sessionManager.getOutboundAbortSignal(sessionId)?.aborted, false);
      config.conversation.outbound.baseDelayMs = 0;
      await coordinator.onTextDelta("按新要求回答");
      await coordinator.flushBufferedChunk();
      assert.deepEqual(sent, ["已发第一段", "按新要求回答"]);
    }
    const history = sessionManager.getLlmVisibleHistory(sessionId).map(item => item.content).join("\n");
    assert.ok(history.includes("已发第一段"));
    assert.ok(!history.includes("未发"));
    assert.ok(!history.includes("旧请求剩余输出"));
  });
}
