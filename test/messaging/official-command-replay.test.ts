import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { processIncomingMessage } from "../../src/app/messaging/messageEventHandler.ts";
import { canActivateRecordedGroupContext } from "../../src/app/messaging/incomingHistory.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { SessionPersistence } from "../../src/conversation/session/sessionPersistence.ts";
import { toPersistedSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import type { MessageEventHandlerDeps } from "../../src/app/messaging/messageHandlerTypes.ts";
import type { ParsedIncomingMessage } from "../../src/services/messaging/incomingMessage.ts";

function commandMessage(connectionId = "qq_official.test-app"): ParsedIncomingMessage {
  return {
    source: "qq_official", channelId: connectionId,
    sourceRef: { platform: "qq_official", connectionId, messageId: "same-message" },
    replyContext: {
      platform: "qq_official", connectionId, chatType: "group", targetId: "group",
      messageId: "same-message", receivedAtMs: 1, expiresAtMs: 9999999999999, maxMessages: 5
    },
    chatType: "group", groupId: "group", userId: "member", senderName: "合成发送者", text: ".stop",
    images: [], audioSources: [], audioIds: [], emojiSources: [], imageIds: [], emojiIds: [],
    forwardIds: [], replyMessageId: null, mentionUserIds: ["bot"], mentionedAll: false, isAtMentioned: true
  };
}

for (const passiveFirst of [false, true]) {
  test(`official AT commands remain consumed after persistence: ${passiveFirst ? "context upgraded" : "AT first"}`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "official-command-replay-"));
    try {
      const config = createTestAppConfig();
      let manager = new SessionManager(config);
      const incoming = commandMessage();
      const sessionId = "qq_official.test-app:g:group";
      let executions = 0;
      const reasons: string[] = [];
      const forbidden = () => { throw new Error("direct commands must not enqueue ordinary replies or model work"); };
      const deps = (): MessageEventHandlerDeps => ({
        inboundDelivery: "qq_official",
        services: {
          config, sessionManager: manager, logger: pino({ level: "silent" }),
          audioStore: { registerSources: async () => [] }, chatFileStore: { importRemoteSource: forbidden },
          userIdentityStore: { ensureUserIdentity: async () => ({ internalUserId: "owner" }) },
          userStore: { touchSeenUser: async () => ({ relationship: "owner" }) },
          setupStore: { get: async () => ({ state: "ready" }) }
        },
        handleDirectCommand: async () => { executions += 1; },
        sendImmediateText: forbidden, flushSession: forbidden,
        persistSession: (_id: string, reason: string) => reasons.push(reason)
      } as unknown as MessageEventHandlerDeps);

      if (passiveFirst) {
        const { replyContext: _permit, ...passive } = incoming;
        await processIncomingMessage(deps(), { ...passive, contextOnly: true, isAtMentioned: false, mentionUserIds: [] });
        assert.equal(canActivateRecordedGroupContext(incoming, manager.getSession(sessionId).internalTranscript), true);
      }
      await processIncomingMessage(deps(), incoming);
      const session = manager.getSession(sessionId);
      assert.equal(executions, 1);
      assert.equal(session.pendingMessages.length, 0);
      assert.equal(session.pendingTranscriptGroupId, null);
      assert.equal(session.internalTranscript.filter(item => item.kind === "user_message").length, passiveFirst ? 1 : 0);
      const command = session.internalTranscript.find(item => item.kind === "direct_command");
      assert.ok(command && command.kind === "direct_command");
      assert.equal(command.direction, "input");
      assert.equal(command.llmVisible, false);
      assert.deepEqual(command.sourceRef, incoming.sourceRef);
      if (passiveFirst) {
        const passive = session.internalTranscript.find(item => item.kind === "user_message");
        assert.equal(passive?.kind === "user_message" && passive.mentionedSelf, false);
      }
      assert.equal(manager.hasHistorySource(sessionId, incoming.sourceRef!), true);
      assert.equal(canActivateRecordedGroupContext(incoming, session.internalTranscript), false);
      await processIncomingMessage(deps(), incoming);
      assert.equal(executions, 1);
      assert.equal(reasons.filter(reason => reason === "direct_command_input_recorded").length, 1);

      const persistence = new SessionPersistence(dataDir, pino({ level: "silent" }));
      await persistence.init();
      await persistence.save(toPersistedSessionState(session));
      const restored = await persistence.loadAll();
      manager = new SessionManager(config);
      manager.restoreSessions(restored);
      assert.equal(manager.hasHistorySource(sessionId, incoming.sourceRef!), true);
      assert.equal(canActivateRecordedGroupContext(incoming, manager.getSession(sessionId).internalTranscript), false);
      await processIncomingMessage(deps(), incoming);
      assert.equal(executions, 1);

      const otherConnection = commandMessage("qq_official.other-app");
      assert.equal(manager.hasHistorySource(sessionId, otherConnection.sourceRef!), false);
      // Force a shared test session to verify source matching itself includes the connection.
      manager.appendUserHistory(sessionId, {
        chatType: "group", userId: "owner", senderName: "合成发送者", text: ".stop",
        sourceRef: otherConnection.sourceRef!, mentionedSelf: false
      }, 2, { transcriptGroup: "standalone" });
      assert.equal(canActivateRecordedGroupContext(otherConnection, manager.getSession(sessionId).internalTranscript), true);
      await processIncomingMessage(deps(), otherConnection, { targetSessionId: sessionId });
      assert.equal(executions, 2);
      await processIncomingMessage(deps(), otherConnection, { targetSessionId: sessionId });
      assert.equal(executions, 2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
