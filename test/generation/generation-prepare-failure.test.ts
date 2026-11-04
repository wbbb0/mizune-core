import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createGenerationSessionOrchestrator } from "../../src/app/generation/generationSessionOrchestrator.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function createHarness(beforeFailure?: (manager: SessionManager, sessionId: string) => void, sendFails = false, supersedeBeforeSend = false) {
  const config = createTestAppConfig({ llm: { enabled: true } });
  const logger = pino({ level: "silent" });
  const sessionManager = new SessionManager(config);
  const sessionId = "qqbot:p:prepare-failure";
  sessionManager.ensureSession({ id: sessionId, type: "private", source: "onebot" });
  const sent: string[] = [];
  let finished = () => {};
  let processNextCount = 0;
  const orchestrator = createGenerationSessionOrchestrator({
    promptBuilder: { config },
    sessionRuntime: {
      logger, sessionManager,
      messageQueue: {
        getDrainPromise() { return null; },
        async enqueueText(input: { send: () => Promise<void> }) {
          if (supersedeBeforeSend) sessionManager.getSession(sessionId).mutationEpoch += 1;
          await input.send();
          return true;
        }
      }
    },
    identity: {
      userStore: {
        async getByUserId() {
          beforeFailure?.(sessionManager, sessionId);
          throw new Error("injected preparation failure");
        }
      }
    },
    toolRuntime: {
      oneBotClient: {
        async sendText(input: { text: string }) {
          sent.push(input.text);
          if (sendFails) throw new Error("injected notification send failure");
          return { status: "ok", retcode: 0, data: { message_id: sent.length } };
        }
      }
    },
    lifecycle: { persistSession() {} }
  } as never, {
    promptBuilder: {} as never,
    async runGeneration() { assert.fail("preparation failure must not call the model executor"); },
    processNextSessionWork() { processNextCount += 1; finished(); }
  });
  return {
    sessionManager, sessionId, sent,
    get processNextCount() { return processNextCount; },
    async turn(delivery?: "onebot" | "qq_official") {
      sessionManager.appendPendingMessage(sessionId, {
        chatType: "private", userId: "owner", senderName: "Owner", text: "test",
        images: [], audioSources: [], audioIds: [], emojiSources: [], imageIds: [], emojiIds: [],
        forwardIds: [], replyMessageId: null, mentionUserIds: [], mentionedAll: false, isAtMentioned: false
      });
      const done = new Promise<void>(resolve => { finished = resolve; });
      orchestrator.flushSession(sessionId, { skipReplyGate: true, ...(delivery ? { delivery } : {}) });
      await done;
    }
  };
}

test("preparation failures notify once and release the session for the next turn", { timeout: 5000 }, async () => {
  const harness = createHarness();
  await harness.turn();
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0]!, /回复失败/);
  assert.equal(harness.sessionManager.isGenerating(harness.sessionId), false);
  assert.equal(harness.sessionManager.getSession(harness.sessionId).activeAssistantResponse, null);
  assert.equal(harness.sessionManager.getLlmVisibleHistory(harness.sessionId).filter(item => item.role === "assistant").length, 1);
  await harness.turn();
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.processNextCount, 2);
});

test("preparation cancellation never sends a failure notification", { timeout: 5000 }, async () => {
  const harness = createHarness((manager, id) => {
    manager.getSession(id).generationAbortController?.abort();
  });
  await harness.turn();
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.sessionManager.isGenerating(harness.sessionId), false);
});

test("stale mutation epochs never send or persist a preparation failure", { timeout: 5000 }, async () => {
  const harness = createHarness((manager, id) => {
    manager.getSession(id).mutationEpoch += 1;
  });
  await harness.turn();
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.sessionManager.getSession(harness.sessionId).internalTranscript.filter(item => item.kind === "fallback_event").length, 0);
});


test("failed preparation notifications do not recurse and still release the session", { timeout: 5000 }, async () => {
  const harness = createHarness(undefined, true);
  await harness.turn();
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.processNextCount, 1);
  assert.equal(harness.sessionManager.isGenerating(harness.sessionId), false);
});

test("official preparation failures without a reply permit stay local", { timeout: 5000 }, async () => {
  const harness = createHarness();
  await harness.turn("qq_official");
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.processNextCount, 1);
  assert.equal(harness.sessionManager.getSession(harness.sessionId).internalTranscript.filter(item => item.kind === "fallback_event").length, 1);
});


test("queued preparation notifications recheck the epoch immediately before delivery", { timeout: 5000 }, async () => {
  const harness = createHarness(undefined, false, true);
  await harness.turn();
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.sessionManager.getLlmVisibleHistory(harness.sessionId).filter(item => item.role === "assistant").length, 0);
  assert.equal(harness.processNextCount, 1);
});
