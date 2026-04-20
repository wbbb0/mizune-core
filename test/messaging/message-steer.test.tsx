import assert from "node:assert/strict";
import pino from "pino";
import { processIncomingMessage } from "../../src/app/messaging/messageEventHandler.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("active natural messages steer into the current generation instead of interrupting it", async () => {
    const config = createTestAppConfig({
      whitelist: {
        enabled: false
      }
    });
    const sessionManager = new SessionManager(config);
    const session = sessionManager.ensureSession({ id: "qqbot:p:10001", type: "private" });
    const started = sessionManager.beginSyntheticGeneration(session.id);
    const persistedReasons: string[] = [];
    let debounceScheduled = 0;
    let flushCalled = 0;

    await processIncomingMessage({
      inboundDelivery: "web",
      services: {
        config,
        logger: pino({ level: "silent" }),
        whitelistStore: {
          hasGroup() {
            return false;
          }
        } as any,
        userIdentityStore: {
          async ensureUserIdentity() {
            return { internalUserId: "u_test_user" };
          },
          async hasOwnerIdentity() {
            return false;
          }
        } as any,
        router: {} as any,
        oneBotClient: {} as any,
        sessionManager,
        debounceManager: {
          schedule() {
            debounceScheduled += 1;
          }
        } as any,
        audioStore: {
          registerSources: async () => []
        } as any,
        chatFileStore: {
          importRemoteSource: async () => null
        } as any,
        mediaCaptionService: {
          schedule() {}
        } as any,
        requestStore: {} as any,
        userStore: {
          touchSeenUser: async () => ({ relationship: "known" })
        } as any,
        setupStore: {
          get: async () => ({ state: "ready" })
        } as any,
        conversationAccess: {
          recordSeenGroupMember: async () => {}
        } as any
      },
      handleDirectCommand: async () => {},
      persistSession: (_sessionId, reason) => {
        persistedReasons.push(reason);
      },
      sendImmediateText: async () => {},
      flushSession: () => {
        flushCalled += 1;
      }
    }, {
      chatType: "private",
      userId: "10001",
      senderName: "tester",
      text: "这是插入消息",
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

    const current = sessionManager.getSession(session.id);
    // Generation continues (not aborted), but outbound queue is interrupted.
    assert.equal(started.abortController.signal.aborted, false);
    assert.equal(started.responseAbortController.signal.aborted, true);
    assert.equal(sessionManager.isResponseOpen(session.id, started.responseEpoch), true);
    // Message is added to both steer (for current tool loop) and pending (for next generation).
    assert.equal(current.pendingMessages.length, 1);
    assert.equal(current.pendingSteerMessages.length, 1);
    const llmVisibleHistory = sessionManager.getLlmVisibleHistory(session.id);
    assert.equal(llmVisibleHistory.length, 1);
    assert.equal(llmVisibleHistory[0]?.role, "user");
    assert.ok(persistedReasons.includes("user_message_steered_and_outbound_interrupted"));
    assert.equal(debounceScheduled, 0);
    assert.equal(flushCalled, 0);
    assert.equal(sessionManager.getReplyDelivery(session.id), "web");
  });

  await runCase("group non-mention messages do not change the session reply delivery flag", async () => {
    const config = createTestAppConfig({
      whitelist: {
        enabled: false
      }
    });
    const sessionManager = new SessionManager(config);
    const session = sessionManager.ensureSession({ id: "qqbot:g:20001", type: "group" });
    sessionManager.setReplyDelivery(session.id, "web");

    await processIncomingMessage({
      inboundDelivery: "onebot",
      services: {
        config,
        logger: pino({ level: "silent" }),
        whitelistStore: {
          hasGroup() {
            return true;
          }
        } as any,
        userIdentityStore: {
          async ensureUserIdentity() {
            return { internalUserId: "u_test_user" };
          },
          async hasOwnerIdentity() {
            return false;
          }
        } as any,
        router: {} as any,
        oneBotClient: {} as any,
        sessionManager,
        debounceManager: {
          schedule() {
            throw new Error("should not schedule");
          }
        } as any,
        audioStore: {
          registerSources: async () => []
        } as any,
        chatFileStore: {
          importRemoteSource: async () => null
        } as any,
        mediaCaptionService: {
          schedule() {}
        } as any,
        requestStore: {} as any,
        userStore: {
          touchSeenUser: async () => ({ relationship: "known" })
        } as any,
        setupStore: {
          get: async () => ({ state: "ready" })
        } as any,
        conversationAccess: {
          recordSeenGroupMember: async () => {}
        } as any
      },
      handleDirectCommand: async () => {},
      persistSession: () => {},
      sendImmediateText: async () => {},
      flushSession: () => {}
    }, {
      chatType: "group",
      userId: "10001",
      groupId: "20001",
      senderName: "tester",
      text: "路过一下",
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

    assert.equal(sessionManager.getReplyDelivery(session.id), "web");
  });

  await runCase("group mention trigger updates the session reply delivery flag", async () => {
    const config = createTestAppConfig({
      whitelist: {
        enabled: false
      }
    });
    const sessionManager = new SessionManager(config);
    const session = sessionManager.ensureSession({ id: "qqbot:g:20001", type: "group" });
    sessionManager.setReplyDelivery(session.id, "web");
    let debounceScheduled = 0;

    await processIncomingMessage({
      inboundDelivery: "onebot",
      services: {
        config,
        logger: pino({ level: "silent" }),
        whitelistStore: {
          hasGroup() {
            return true;
          }
        } as any,
        userIdentityStore: {
          async ensureUserIdentity() {
            return { internalUserId: "u_test_user" };
          },
          async hasOwnerIdentity() {
            return false;
          }
        } as any,
        router: {} as any,
        oneBotClient: {} as any,
        sessionManager,
        debounceManager: {
          schedule() {
            debounceScheduled += 1;
          }
        } as any,
        audioStore: {
          registerSources: async () => []
        } as any,
        chatFileStore: {
          importRemoteSource: async () => null
        } as any,
        mediaCaptionService: {
          schedule() {}
        } as any,
        requestStore: {} as any,
        userStore: {
          touchSeenUser: async () => ({ relationship: "known" })
        } as any,
        setupStore: {
          get: async () => ({ state: "ready" })
        } as any,
        conversationAccess: {
          recordSeenGroupMember: async () => {}
        } as any
      },
      handleDirectCommand: async () => {},
      persistSession: () => {},
      sendImmediateText: async () => {},
      flushSession: () => {}
    }, {
      chatType: "group",
      userId: "10001",
      groupId: "20001",
      senderName: "tester",
      text: "@bot 你好",
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
      isAtMentioned: true
    });

    assert.equal(debounceScheduled, 1);
    assert.equal(sessionManager.getReplyDelivery(session.id), "onebot");
  });

  await runCase("owner group mention triggers even when the group is not whitelisted", async () => {
    const config = createTestAppConfig({
      whitelist: {
        enabled: true
      }
    });
    const sessionManager = new SessionManager(config);
    const session = sessionManager.ensureSession({ id: "qqbot:g:20001", type: "group" });
    let debounceScheduled = 0;

    await processIncomingMessage({
      inboundDelivery: "onebot",
      services: {
        config,
        logger: pino({ level: "silent" }),
        whitelistStore: {
          hasGroup() {
            return false;
          }
        } as any,
        userIdentityStore: {
          async ensureUserIdentity() {
            return { internalUserId: "owner" };
          },
          async hasOwnerIdentity() {
            return true;
          }
        } as any,
        router: {} as any,
        oneBotClient: {} as any,
        sessionManager,
        debounceManager: {
          schedule() {
            debounceScheduled += 1;
          }
        } as any,
        audioStore: {
          registerSources: async () => []
        } as any,
        chatFileStore: {
          importRemoteSource: async () => null
        } as any,
        mediaCaptionService: {
          schedule() {}
        } as any,
        requestStore: {} as any,
        userStore: {
          touchSeenUser: async () => ({ relationship: "owner" })
        } as any,
        setupStore: {
          get: async () => ({ state: "ready" })
        } as any,
        conversationAccess: {
          recordSeenGroupMember: async () => {}
        } as any
      },
      handleDirectCommand: async () => {},
      persistSession: () => {},
      sendImmediateText: async () => {},
      flushSession: () => {}
    }, {
      chatType: "group",
      userId: "10001",
      groupId: "20001",
      senderName: "owner",
      text: "@bot 你好",
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
      isAtMentioned: true
    });

    assert.equal(debounceScheduled, 1);
    assert.equal(sessionManager.getReplyDelivery(session.id), "onebot");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
