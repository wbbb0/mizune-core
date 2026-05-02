import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createSessionTranscriptStore } from "../../src/conversation/session/sessionTranscriptStore.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("ambient transcript remains visible in raw session view but is excluded from llm history", () => {
  const sessionManager = new SessionManager(createTestAppConfig());
  const sessionId = "qqbot:g:20001";
  sessionManager.ensureSession({ id: sessionId, type: "group" });

  sessionManager.appendUserHistory(sessionId, {
    chatType: "group",
    userId: "u1",
    senderName: "Alice",
    text: "普通群聊环境",
    runtimeVisibility: "ambient"
  }, 10, { transcriptGroup: "standalone" });
  sessionManager.appendUserHistory(sessionId, {
    chatType: "group",
    userId: "u2",
    senderName: "Bob",
    text: "@bot 当前问题"
  }, 20);

  const llmHistory = sessionManager.getLlmVisibleHistory(sessionId);
  assert.equal(llmHistory.length, 1);
  assert.match(llmHistory[0]?.content ?? "", /Bob/);
  assert.match(llmHistory[0]?.content ?? "", /@bot 当前问题/);

  const rawItems = sessionManager.getSessionView(sessionId).internalTranscript;
  assert.equal(rawItems.length, 2);
  assert.equal(rawItems[0]?.kind, "user_message");
  assert.equal(rawItems[0]?.runtimeVisibility, "ambient");
  assert.equal(rawItems[0]?.runtimeExcluded, false);
});

test("standalone ambient transcript does not reuse a pending trigger transcript group", () => {
  const sessionManager = new SessionManager(createTestAppConfig());
  const sessionId = "qqbot:g:20001";
  sessionManager.ensureSession({ id: sessionId, type: "group" });

  sessionManager.appendUserHistory(sessionId, {
    chatType: "group",
    userId: "u1",
    senderName: "Alice",
    text: "@bot 当前问题"
  }, 10);
  const triggerGroupId = sessionManager.getSession(sessionId).pendingTranscriptGroupId;
  assert.ok(triggerGroupId);

  sessionManager.appendUserHistory(sessionId, {
    chatType: "group",
    userId: "u2",
    senderName: "Bob",
    text: "普通补充",
    runtimeVisibility: "ambient"
  }, 20, { transcriptGroup: "standalone" });

  const rawItems = sessionManager.getSessionView(sessionId).internalTranscript;
  assert.notEqual(rawItems[0]?.groupId, rawItems[1]?.groupId);
  assert.equal(sessionManager.getSession(sessionId).pendingTranscriptGroupId, triggerGroupId);
});

test("ambient recall can add a bounded group context window for triggered prompts", () => {
  const config = createTestAppConfig({
    conversation: {
      group: {
        ambientRecallMessageCount: 1
      }
    }
  });
  const sessionManager = new SessionManager(config);
  const sessionId = "qqbot:g:20001";
  sessionManager.ensureSession({ id: sessionId, type: "group" });

  sessionManager.appendUserHistory(sessionId, {
    chatType: "group",
    userId: "u1",
    senderName: "Alice",
    text: "较早的普通群聊",
    runtimeVisibility: "ambient"
  }, 10, { transcriptGroup: "standalone" });
  sessionManager.appendUserHistory(sessionId, {
    chatType: "group",
    userId: "u2",
    senderName: "Bob",
    text: "最近的普通群聊",
    runtimeVisibility: "ambient"
  }, 20, { transcriptGroup: "standalone" });
  sessionManager.appendUserHistory(sessionId, {
    chatType: "group",
    userId: "u3",
    senderName: "Carol",
    text: "@bot 刚才那个怎么处理"
  }, 30);

  const session = sessionManager.getSession(sessionId);
  const store = createSessionTranscriptStore(session, config);
  const promptHistory = store.projectRuntimeHistoryForPrompt({
    excludeGroupId: session.pendingTranscriptGroupId,
    includeAmbientRecall: true
  });

  assert.equal(promptHistory.some((message) => message.content.includes("较早的普通群聊")), false);
  assert.equal(promptHistory.some((message) => message.content.includes("最近的普通群聊")), true);
  assert.equal(promptHistory.some((message) => message.content.includes("群聊环境")), true);
  assert.equal(promptHistory.some((message) => message.content.includes("@bot 刚才那个怎么处理")), false);
  assert.equal(sessionManager.getLlmVisibleHistory(sessionId).some((message) => message.content.includes("最近的普通群聊")), false);
});

test("ambient recall projection only returns ambient messages for provider replay prompts", () => {
  const config = createTestAppConfig({
    conversation: {
      group: {
        ambientRecallMessageCount: 1
      }
    }
  });
  const sessionManager = new SessionManager(config);
  const sessionId = "qqbot:g:20001";
  sessionManager.ensureSession({ id: sessionId, type: "group" });

  sessionManager.appendUserHistory(sessionId, {
    chatType: "group",
    userId: "u1",
    senderName: "Alice",
    text: "普通可见历史"
  }, 10, { transcriptGroup: "standalone" });
  sessionManager.appendUserHistory(sessionId, {
    chatType: "group",
    userId: "u2",
    senderName: "Bob",
    text: "最近环境消息",
    runtimeVisibility: "ambient"
  }, 20, { transcriptGroup: "standalone" });
  sessionManager.appendUserHistory(sessionId, {
    chatType: "group",
    userId: "u3",
    senderName: "Carol",
    text: "@bot 当前问题"
  }, 30);

  const session = sessionManager.getSession(sessionId);
  const store = createSessionTranscriptStore(session, config);
  const ambientRecall = store.projectAmbientRecallForPrompt({
    excludeGroupId: session.pendingTranscriptGroupId
  });

  assert.equal(ambientRecall.length, 1);
  assert.equal(ambientRecall.some((message) => message.content.includes("普通可见历史")), false);
  assert.equal(ambientRecall.some((message) => message.content.includes("最近环境消息")), true);
  assert.equal(ambientRecall.some((message) => message.content.includes("@bot 当前问题")), false);
});
