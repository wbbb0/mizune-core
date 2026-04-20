import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { SessionLifecycleController } from "../../src/conversation/session/sessionLifecycleController.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("interrupting a response clears preview without appending a merged assistant history item", async () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const lifecycle = new SessionLifecycleController();
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });

    const { responseEpoch } = sessionManager.beginSyntheticGeneration("qqbot:p:test");
    const buffered = sessionManager.appendActiveAssistantResponseChunkIfResponseEpochMatches(
      "qqbot:p:test",
      responseEpoch,
      {
        chatType: "private",
        userId: "10001",
        senderName: "tester"
      },
      "第一段。第二段。",
      10
    );

    assert.equal(buffered, true);

    const interrupted = lifecycle.interruptResponse(sessionManager.getSession("qqbot:p:test"));
    assert.equal(interrupted.finalizedAssistant, true);

    const session = sessionManager.getSession("qqbot:p:test");
    const llmVisibleHistory = sessionManager.getLlmVisibleHistory("qqbot:p:test");
    assert.equal(session.activeAssistantResponse, null);
    assert.equal(llmVisibleHistory.length, 0);
  });

  await runCase("stale response epochs cannot append assistant chunks after interruption", async () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const lifecycle = new SessionLifecycleController();
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });

    const { responseEpoch } = sessionManager.beginSyntheticGeneration("qqbot:p:test");
    lifecycle.interruptResponse(sessionManager.getSession("qqbot:p:test"));

    const appended = sessionManager.appendActiveAssistantResponseChunkIfResponseEpochMatches(
      "qqbot:p:test",
      responseEpoch,
      {
        chatType: "private",
        userId: "10001",
        senderName: "tester"
      },
      "late chunk",
      20
    );

    assert.equal(appended, false);
    assert.equal(sessionManager.getSession("qqbot:p:test").activeAssistantResponse, null);
  });

  await runCase("newline-split assistant chunks remain only in active preview until sent history is appended", async () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const lifecycle = new SessionLifecycleController();
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });

    const { responseEpoch } = sessionManager.beginSyntheticGeneration("qqbot:p:test");
    sessionManager.appendActiveAssistantResponseChunkIfResponseEpochMatches(
      "qqbot:p:test",
      responseEpoch,
      {
        chatType: "private",
        userId: "10001",
        senderName: "tester"
      },
      "第一段",
      10
    );
    sessionManager.appendActiveAssistantResponseChunkIfResponseEpochMatches(
      "qqbot:p:test",
      responseEpoch,
      {
        chatType: "private",
        userId: "10001",
        senderName: "tester"
      },
      "第二段",
      20,
      {
        joinWithDoubleNewline: true
      }
    );

    const interrupted = lifecycle.interruptResponse(sessionManager.getSession("qqbot:p:test"));
    assert.equal(interrupted.finalizedAssistant, true);

    const session = sessionManager.getSession("qqbot:p:test");
    const llmVisibleHistory = sessionManager.getLlmVisibleHistory("qqbot:p:test");
    assert.equal(session.activeAssistantResponse, null);
    assert.equal(llmVisibleHistory.length, 0);
  });

  await runCase("steer messages can be consumed immediately or promoted into the next round", async () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });

    sessionManager.appendSteerMessage("qqbot:p:test", {
      chatType: "private",
      userId: "10001",
      senderName: "tester",
      text: "补充要求",
      images: [],
      audioSources: [],
      audioIds: [],
      emojiSources: [],
      imageIds: [],
      emojiIds: [],
      attachments: [],
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      isAtMentioned: false
    });

    assert.equal(sessionManager.hasPendingSteerMessages("qqbot:p:test"), true);
    const consumed = sessionManager.consumeSteerMessages("qqbot:p:test");
    assert.equal(consumed.length, 1);
    assert.equal(consumed[0]?.text, "补充要求");
    assert.equal(sessionManager.hasPendingSteerMessages("qqbot:p:test"), false);

    sessionManager.appendSteerMessage("qqbot:p:test", {
      chatType: "private",
      userId: "10001",
      senderName: "tester",
      text: "转下一轮",
      images: [],
      audioSources: [],
      audioIds: [],
      emojiSources: [],
      imageIds: [],
      emojiIds: [],
      attachments: [],
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      isAtMentioned: false
    });

    const promoted = sessionManager.promoteSteerMessagesToPending("qqbot:p:test");
    assert.equal(promoted, 1);
    const session = sessionManager.getSession("qqbot:p:test");
    assert.equal(session.pendingSteerMessages.length, 0);
    assert.equal(session.pendingMessages.length, 1);
    assert.equal(session.pendingMessages[0]?.text, "转下一轮");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
