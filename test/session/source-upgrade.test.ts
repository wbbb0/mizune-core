import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createSessionTranscriptStore } from "../../src/conversation/session/sessionTranscriptStore.ts";
import { publishConversation } from "../../src/conversation/crossConversationContext.ts";
import type { TranscriptItemSourceRef } from "../../src/conversation/session/sessionTypes.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

const sourceRef: TranscriptItemSourceRef = {
  platform: "qq_official", connectionId: "test-app", messageId: "opaque-message"
};

function createManager() {
  const config = createTestAppConfig();
  const manager = new SessionManager(config);
  const id = "qq_official.test-app:g:group";
  manager.ensureSession({ id, type: "group", source: "qq_official" });
  return { manager, config, id, session: manager.getSession(id) };
}

test("official context upgrades in place into the pending input group without duplicating prompt history", () => {
  const { manager, config, id, session } = createManager();
  const rootMessage = { chatType: "group" as const, userId: "owner", senderName: "当前发送者", text: "原始群消息", sourceRef };
  manager.appendUserHistory(id, rootMessage, 10, { transcriptGroup: "standalone" });
  manager.appendUserHistory(id, { chatType: "group", userId: "other", senderName: "后续发送者", text: "后续消息" }, 20,
    { transcriptGroup: "standalone" });
  const original = session.internalTranscript[0]!;
  const later = session.internalTranscript[1]!;
  const revision = session.historyRevision;
  publishConversation(session, 30);
  let notifications = 0;
  const unsubscribe = manager.subscribeSession(id, () => notifications++);

  manager.appendUserHistory(id, {
    ...rootMessage,
    text: "请回答引用内容",
    mentionedSelf: true,
    mentionUserIds: ["bot"],
    contentParts: [
      { kind: "text", text: "请回答引用内容" },
      { kind: "embedded_message", relation: "reply", senderId: "unrelated-user", senderName: "引用作者",
        parts: [{ kind: "text", text: "引用正文" }] }
    ]
  }, 100, { upsertSource: true });

  const upgraded = session.internalTranscript[0]!;
  assert.equal(session.internalTranscript.length, 2);
  assert.equal(upgraded.id, original.id);
  assert.equal(upgraded.timestampMs, 10);
  assert.equal(session.internalTranscript[1], later);
  assert.notEqual(upgraded.groupId, original.groupId);
  assert.equal(upgraded.groupId, session.pendingTranscriptGroupId);
  assert.equal(upgraded.kind, "user_message");
  if (upgraded.kind !== "user_message") throw new Error("Expected root user message");
  assert.equal(upgraded.userId, "owner");
  assert.equal(upgraded.senderName, "当前发送者");
  assert.equal(upgraded.mentionedSelf, true);
  assert.equal(upgraded.contentParts?.[1]?.kind, "embedded_message");
  assert.ok(Object.isFrozen(upgraded));
  assert.ok(Object.isFrozen(upgraded.contentParts));
  assert.ok(upgraded.tokenStats?.input);
  assert.equal(session.historyRevision, revision + 1);
  assert.equal(session.publishedConversation, null);
  assert.equal(notifications, 1);

  const store = createSessionTranscriptStore(session, config);
  assert.equal(store.projectVisibleMessages().length, 2);
  const promptHistory = store.projectRuntimeHistoryForPrompt({ excludeGroupId: session.pendingTranscriptGroupId });
  assert.equal(promptHistory.length, 1);
  assert.match(promptHistory[0]!.content, /后续消息/);
  assert.equal(promptHistory.some(item => item.content.includes("请回答引用内容")), false);

  manager.appendUserHistory(id, rootMessage, 200);
  assert.equal(session.internalTranscript.length, 2);
  assert.equal(session.internalTranscript[0], upgraded);
  assert.equal(session.historyRevision, revision + 1);
  unsubscribe();
});

test("source upsert preserves manual exclusions and only invalidates intersecting published messages", () => {
  const { manager, id, session } = createManager();
  manager.appendUserHistory(id, { chatType: "group", userId: "user", senderName: "发送者", text: "已发布消息" }, 1);
  publishConversation(session, 2);
  const published = session.publishedConversation;
  const message = { chatType: "group" as const, userId: "user", senderName: "发送者", text: "稍后进入的消息", sourceRef };
  manager.appendUserHistory(id, message, 3, { transcriptGroup: "standalone" });
  const original = session.internalTranscript[1]!;
  manager.excludeTranscriptItem(id, original.id!, "manual_single", 4);
  manager.appendUserHistory(id, { ...message, text: "补全消息", contentParts: [
    { kind: "embedded_message", relation: "reply", senderId: "owner", parts: [{ kind: "text", text: "引用管理员" }] }
  ] }, 5, { upsertSource: true, transcriptGroupId: "queued-input" });

  const upgraded = session.internalTranscript[1]!;
  assert.equal(upgraded.id, original.id);
  assert.equal(upgraded.timestampMs, 3);
  assert.equal(upgraded.groupId, "queued-input");
  assert.equal(upgraded.runtimeExcluded, true);
  assert.equal(upgraded.runtimeExcludedAt, 4);
  assert.equal(upgraded.runtimeExclusionReason, "manual_single");
  assert.equal(upgraded.kind === "user_message" && upgraded.userId, "user");
  assert.equal(session.publishedConversation, published);
  assert.equal(manager.getLlmVisibleHistory(id).length, 1);
});

test("source matching includes official connection and upsert appends normally when no source exists", () => {
  const { manager, id, session } = createManager();
  const message = { chatType: "group" as const, userId: "user", senderName: "发送者", text: "输入", sourceRef };
  manager.appendUserHistory(id, message, 1, { upsertSource: true });
  manager.appendUserHistory(id, { ...message, sourceRef: { ...sourceRef, connectionId: "another-app" } }, 2,
    { upsertSource: true });
  assert.equal(session.internalTranscript.length, 2);
  assert.notEqual(session.internalTranscript[0]?.id, session.internalTranscript[1]?.id);
  assert.equal(manager.hasHistorySource(id, sourceRef), true);
  assert.equal(manager.hasHistorySource(id, { ...sourceRef, connectionId: "absent-app" }), false);
});
