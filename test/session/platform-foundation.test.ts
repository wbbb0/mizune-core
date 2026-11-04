import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { toPersistedSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
import { transcriptItemSourceRefSchema } from "../../src/conversation/session/transcriptContract.ts";
import type { ParsedIncomingMessage } from "../../src/services/messaging/incomingMessage.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("official reply permits remain attached to queued messages and are never persisted", () => {
  const permit = { platform: "qq_official" as const, connectionId: "qq_official.app", chatType: "group" as const,
    targetId: "group", messageId: "source-A", receivedAtMs: 1, expiresAtMs: 300001, maxMessages: 5 };
  const message: ParsedIncomingMessage = { source: "qq_official", channelId: permit.connectionId,
    replyContext: permit, sourceRef: { platform: "qq_official", connectionId: permit.connectionId, messageId: permit.messageId },
    chatType: "group", groupId: "group", userId: "member", senderName: "成员", text: "你好", images: [], audioSources: [],
    audioIds: [], emojiSources: [], imageIds: [], emojiIds: [], forwardIds: [], replyMessageId: null,
    mentionUserIds: [], mentionedAll: false, isAtMentioned: true };
  const manager = new SessionManager(createTestAppConfig());
  const session = manager.getOrCreateSession(message);
  manager.appendPendingMessage(session.id, message);
  assert.equal(session.source, "qq_official");
  assert.equal(session.pacingPreferences.outbound, "immediate");
  assert.equal(session.pendingMessages[0]?.replyContext, permit);
  assert.equal(JSON.stringify(toPersistedSessionState(session)).includes('"replyContext"'), false);
  manager.beginGeneration(session.id);
  assert.equal(session.currentReplyTarget?.replyContext, permit);
});

test("official message references preserve opaque IDs and require the connection namespace", () => {
  assert.deepEqual(transcriptItemSourceRefSchema.parse({ platform: "qq_official", connectionId: "qq_official.app", messageId: "ROBOT1.0_opaque" }),
    { platform: "qq_official", connectionId: "qq_official.app", messageId: "ROBOT1.0_opaque" });
  assert.equal(transcriptItemSourceRefSchema.safeParse({ platform: "qq_official", messageId: "opaque" }).success, false);
});
