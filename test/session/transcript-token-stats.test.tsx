import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("session transcript keeps more than 160 items and records estimated input token stats", () => {
  const sessionManager = new SessionManager(createTestAppConfig());
  const sessionId = "qqbot:p:test";
  sessionManager.ensureSession({ id: sessionId, type: "private" });

  for (let index = 0; index < 170; index += 1) {
    sessionManager.appendUserHistory(sessionId, {
      chatType: "private",
      userId: "tester",
      senderName: "tester",
      text: `hello ${index}`
    }, index + 1);
  }

  const session = sessionManager.getSession(sessionId);
  assert.equal(session.internalTranscript.length, 170);
  const first = session.internalTranscript[0];
  assert.equal(first?.kind, "user_message");
  assert.equal(first?.tokenStats?.input?.source, "estimated");
  assert.ok((first?.tokenStats?.input?.tokens ?? 0) > 0);
});

test("session manager distributes provider output token stats across active assistant response messages", () => {
  const sessionManager = new SessionManager(createTestAppConfig());
  const sessionId = "qqbot:p:test";
  sessionManager.ensureSession({ id: sessionId, type: "private" });
  const { responseEpoch } = sessionManager.beginSyntheticGeneration(sessionId);

  assert.equal(sessionManager.appendHistoryIfResponseEpochMatches(sessionId, responseEpoch, {
    chatType: "private",
    userId: "assistant",
    senderName: "assistant",
    text: "short"
  }, 1), true);
  assert.equal(sessionManager.appendHistoryIfResponseEpochMatches(sessionId, responseEpoch, {
    chatType: "private",
    userId: "assistant",
    senderName: "assistant",
    text: "long long long"
  }, 2), true);

  assert.equal(sessionManager.applyActiveResponseTokenStatsIfResponseEpochMatches(sessionId, responseEpoch, {
    outputTokens: 40,
    reasoningTokens: 10,
    modelRef: "main",
    model: "fake",
    providerReported: true,
    capturedAt: 3
  }), true);

  const assistantItems = sessionManager.getSession(sessionId).internalTranscript
    .filter((item) => item.kind === "assistant_message");
  assert.equal(assistantItems.length, 2);
  assert.equal(
    assistantItems.reduce((sum, item) => sum + (item.tokenStats?.output?.tokens ?? 0), 0),
    40
  );
  assert.equal(
    assistantItems.reduce((sum, item) => sum + (item.tokenStats?.reasoning?.tokens ?? 0), 0),
    10
  );
  assert.ok((assistantItems[1]?.tokenStats?.output?.tokens ?? 0) > (assistantItems[0]?.tokenStats?.output?.tokens ?? 0));
});
