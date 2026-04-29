import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { backfillOneBotSessionHistory } from "../../src/app/runtime/oneBotHistoryBackfill.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("OneBot history backfill appends existing session history without triggering pending work", async () => {
  const config = createTestAppConfig({
    onebot: {
      provider: "napcat",
      historyBackfill: {
        enabled: true,
        maxMessagesPerSession: 10,
        maxTotalMessages: 10,
        requestDelayMs: 0
      }
    }
  });
  const sessionManager = new SessionManager(config);
  sessionManager.ensureSession({
    id: "test:p:123",
    type: "private",
    source: "onebot",
    participantRef: { kind: "user", id: "123" }
  });
  sessionManager.getSession("test:p:123").historyBackfillBoundaryMs = 0;

  const persisted: string[] = [];
  const stats = await backfillOneBotSessionHistory({
    config,
    logger: pino({ level: "silent" }),
    importBeforeMs: 1710000010000,
    oneBotClient: {
      async getLoginInfo() {
        return { user_id: 999, nickname: "bot" };
      },
      async getPrivateMessageHistory(input) {
        assert.equal(input.userId, "123");
        return [{
          message_id: 11,
          message_type: "private",
          sub_type: "friend",
          user_id: 123,
          message: [{ type: "text", data: { text: "offline hello" } }],
          raw_message: "offline hello",
          sender: { user_id: 123, nickname: "Alice" },
          time: 1710000001,
          font: 0
        }];
      },
      async getGroupMessageHistory() {
        throw new Error("unexpected group history call");
      }
    },
    sessionManager,
    audioStore: {
      async registerSources() {
        return [];
      }
    } as any,
    chatFileStore: {
      async importRemoteSource() {
        return null;
      }
    } as any,
    userIdentityStore: {
      async ensureUserIdentity(input: { externalId: string }) {
        return { internalUserId: `onebot:${input.externalId}` };
      }
    } as any,
    userStore: {
      async touchSeenUser() {
        return { relationship: "unknown" };
      }
    } as any,
    setupStore: {
      async get() {
        return { state: "ready" };
      }
    } as any,
    persistSession(sessionId) {
      persisted.push(sessionId);
    }
  });

  assert.equal(stats.appendedMessages, 1);
  assert.deepEqual(persisted, ["test:p:123"]);

  const session = sessionManager.getSession("test:p:123");
  assert.equal(session.pendingMessages.length, 0);
  assert.equal(session.pendingSteerMessages.length, 0);
  assert.equal(session.phase.kind, "idle");
  assert.equal(session.internalTranscript.length, 1);
  const item = session.internalTranscript[0];
  assert.equal(item?.kind, "user_message");
  if (item?.kind === "user_message") {
    assert.equal(item.text, "offline hello");
    assert.equal(item.userId, "onebot:123");
    assert.deepEqual(item.sourceRef, { platform: "onebot", messageId: 11 });
    assert.equal(item.timestampMs, 1710000001000);
  }
});

test("OneBot history backfill skips startup-time messages so live ingress can handle them", async () => {
  const config = createTestAppConfig({
    onebot: {
      provider: "napcat",
      historyBackfill: {
        enabled: true,
        maxMessagesPerSession: 10,
        maxTotalMessages: 10,
        requestDelayMs: 0
      }
    }
  });
  const sessionManager = new SessionManager(config);
  sessionManager.ensureSession({
    id: "test:p:321",
    type: "private",
    source: "onebot",
    participantRef: { kind: "user", id: "321" }
  });
  sessionManager.getSession("test:p:321").historyBackfillBoundaryMs = 0;

  const stats = await backfillOneBotSessionHistory({
    config,
    logger: pino({ level: "silent" }),
    importBeforeMs: 1710000002000,
    oneBotClient: {
      async getLoginInfo() {
        return { user_id: 999 };
      },
      async getPrivateMessageHistory() {
        return [
          {
            message_id: 41,
            message_type: "private",
            sub_type: "friend",
            user_id: 321,
            message: [{ type: "text", data: { text: "before startup" } }],
            raw_message: "before startup",
            sender: { user_id: 321, nickname: "Alice" },
            time: 1710000001,
            font: 0
          },
          {
            message_id: 42,
            message_type: "private",
            sub_type: "friend",
            user_id: 321,
            message: [{ type: "text", data: { text: "same second as startup" } }],
            raw_message: "same second as startup",
            sender: { user_id: 321, nickname: "Alice" },
            time: 1710000002,
            font: 0
          }
        ];
      },
      async getGroupMessageHistory() {
        throw new Error("unexpected group history call");
      }
    },
    sessionManager,
    audioStore: { async registerSources() { return []; } } as any,
    chatFileStore: { async importRemoteSource() { return null; } } as any,
    userIdentityStore: {
      async ensureUserIdentity(input: { externalId: string }) {
        return { internalUserId: `onebot:${input.externalId}` };
      }
    } as any,
    userStore: { async touchSeenUser() { return { relationship: "unknown" }; } } as any,
    setupStore: { async get() { return { state: "ready" }; } } as any,
    persistSession() {}
  });

  assert.equal(stats.appendedMessages, 1);
  assert.deepEqual(
    sessionManager.getSession("test:p:321").internalTranscript
      .filter((item) => item.kind === "user_message")
      .map((item) => item.text),
    ["before startup"]
  );
});

test("OneBot history backfill skips already imported source messages", async () => {
  const config = createTestAppConfig({
    onebot: {
      provider: "napcat",
      historyBackfill: {
        enabled: true,
        maxMessagesPerSession: 10,
        maxTotalMessages: 10,
        requestDelayMs: 0
      }
    }
  });
  const sessionManager = new SessionManager(config);
  sessionManager.ensureSession({
    id: "test:g:456",
    type: "group",
    source: "onebot",
    participantRef: { kind: "group", id: "456" }
  });
  sessionManager.getSession("test:g:456").historyBackfillBoundaryMs = 0;

  const client = {
    async getLoginInfo() {
      return { user_id: 999 };
    },
    async getPrivateMessageHistory() {
      throw new Error("unexpected private history call");
    },
    async getGroupMessageHistory() {
      return [{
        message_id: "22",
        message_type: "group",
        sub_type: "normal",
        user_id: 123,
        group_id: 456,
        message: [{ type: "text", data: { text: "group gap" } }],
        raw_message: "group gap",
        sender: { user_id: 123, card: "Alice" },
        time: 1710000002,
        font: 0
      }];
    }
  };

  const deps = {
    config,
    logger: pino({ level: "silent" }),
    importBeforeMs: 1710000010000,
    oneBotClient: client,
    sessionManager,
    audioStore: { async registerSources() { return []; } } as any,
    chatFileStore: { async importRemoteSource() { return null; } } as any,
    userIdentityStore: {
      async ensureUserIdentity(input: { externalId: string }) {
        return { internalUserId: `onebot:${input.externalId}` };
      }
    } as any,
    userStore: { async touchSeenUser() { return { relationship: "unknown" }; } } as any,
    setupStore: { async get() { return { state: "ready" }; } } as any,
    persistSession() {}
  };

  const first = await backfillOneBotSessionHistory(deps);
  const second = await backfillOneBotSessionHistory(deps);

  assert.equal(first.appendedMessages, 1);
  assert.equal(second.appendedMessages, 0);
  const session = sessionManager.getSession("test:g:456");
  assert.equal(session.internalTranscript.length, 1);
  const item = session.internalTranscript[0];
  assert.equal(item?.kind, "user_message");
  if (item?.kind === "user_message") {
    assert.deepEqual(item.sourceRef, { platform: "onebot", messageId: 22 });
  }
});

test("OneBot history backfill inserts by timestamp and respects the session backfill boundary", async () => {
  const config = createTestAppConfig({
    onebot: {
      provider: "napcat",
      historyBackfill: {
        enabled: true,
        maxMessagesPerSession: 10,
        maxTotalMessages: 10,
        requestDelayMs: 0
      }
    }
  });
  const sessionManager = new SessionManager(config);
  const session = sessionManager.ensureSession({
    id: "test:p:789",
    type: "private",
    source: "onebot",
    participantRef: { kind: "user", id: "789" }
  });
  session.historyBackfillBoundaryMs = 1710000001000;
  sessionManager.appendUserHistory("test:p:789", {
    chatType: "private",
    userId: "onebot:789",
    senderName: "Alice",
    text: "already newer"
  }, 1710000003000);

  const stats = await backfillOneBotSessionHistory({
    config,
    logger: pino({ level: "silent" }),
    importBeforeMs: 1710000010000,
    oneBotClient: {
      async getLoginInfo() {
        return { user_id: 999 };
      },
      async getPrivateMessageHistory() {
        return [
          {
            message_id: 31,
            message_type: "private",
            sub_type: "friend",
            user_id: 789,
            message: [{ type: "text", data: { text: "too old" } }],
            raw_message: "too old",
            sender: { user_id: 789, nickname: "Alice" },
            time: 1710000000,
            font: 0
          },
          {
            message_id: 32,
            message_type: "private",
            sub_type: "friend",
            user_id: 789,
            message: [{ type: "text", data: { text: "inserted middle" } }],
            raw_message: "inserted middle",
            sender: { user_id: 789, nickname: "Alice" },
            time: 1710000002,
            font: 0
          }
        ];
      },
      async getGroupMessageHistory() {
        throw new Error("unexpected group history call");
      }
    },
    sessionManager,
    audioStore: { async registerSources() { return []; } } as any,
    chatFileStore: { async importRemoteSource() { return null; } } as any,
    userIdentityStore: {
      async ensureUserIdentity(input: { externalId: string }) {
        return { internalUserId: `onebot:${input.externalId}` };
      }
    } as any,
    userStore: { async touchSeenUser() { return { relationship: "unknown" }; } } as any,
    setupStore: { async get() { return { state: "ready" }; } } as any,
    persistSession() {}
  });

  assert.equal(stats.appendedMessages, 1);
  assert.deepEqual(
    sessionManager.getSession("test:p:789").internalTranscript
      .filter((item) => item.kind === "user_message")
      .map((item) => item.text),
    ["inserted middle", "already newer"]
  );
});
