import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

  test("debounce batch user messages share a group and interrupting input starts a new one", () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const sessionId = "qqbot:p:test";
    sessionManager.ensureSession({ id: sessionId, type: "private" });

    sessionManager.appendUserHistory(sessionId, {
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text: "第一条"
    }, 10);
    sessionManager.appendUserHistory(sessionId, {
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text: "第二条"
    }, 20);

    const sessionBeforeTurn = sessionManager.getSession(sessionId);
    const firstGroupId = sessionBeforeTurn.internalTranscript[0]?.groupId;
    assert.equal(firstGroupId, sessionBeforeTurn.internalTranscript[1]?.groupId);

    sessionManager.appendPendingMessage(sessionId, {
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text: "第一条",
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

    sessionManager.beginGeneration(sessionId);
    sessionManager.appendInternalTranscript(sessionId, {
      kind: "status_message",
      llmVisible: false,
      role: "assistant",
      statusType: "system",
      content: "处理中",
      timestampMs: 30
    });

    const sessionDuringTurn = sessionManager.getSession(sessionId);
    assert.equal(sessionDuringTurn.internalTranscript[2]?.groupId, firstGroupId);

    sessionManager.appendUserHistory(sessionId, {
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text: "打断后的新消息"
    }, 40);

    const sessionAfterInterrupt = sessionManager.getSession(sessionId);
    assert.notEqual(sessionAfterInterrupt.internalTranscript[3]?.groupId, firstGroupId);
  });
