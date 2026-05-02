import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { processIncomingMessage } from "../../src/app/messaging/messageEventHandler.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

  test("active natural messages interrupt the current generation and queue the next turn", async () => {
    const config = createTestAppConfig({
      whitelist: {
        enabled: false
      }
    });
    const sessionManager = new SessionManager(config);
    const session = sessionManager.ensureSession({ id: "qqbot:p:10001", type: "private" });
    const started = sessionManager.beginSyntheticGeneration(session.id);
    assert.equal(sessionManager.setActiveAssistantDraftResponseIfResponseEpochMatches(
      session.id,
      started.responseEpoch,
      {
        chatType: "private",
        userId: "10001",
        senderName: "tester"
      },
      "这是打断前已经流式展示的半截回答",
      20
    ), true);
    const oldMutationEpoch = sessionManager.getMutationEpoch(session.id);
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
        personaStore: {} as any,
        setupStore: {
          get: async () => ({ state: "ready" })
        } as any,
        globalProfileReadinessStore: {
          get: async () => ({ persona: "ready", rp: "ready", scenario: "ready" })
        } as any,
        rpProfileStore: {} as any,
        scenarioProfileStore: {} as any,
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
    // Natural user input interrupts the active answer instead of steering the old turn.
    assert.equal(started.abortController.signal.aborted, true);
    assert.equal(started.responseAbortController.signal.aborted, true);
    assert.equal(sessionManager.isResponseOpen(session.id, started.responseEpoch), false);
    assert.equal(sessionManager.hasActiveResponse(session.id), false);
    assert.ok(sessionManager.getMutationEpoch(session.id) > oldMutationEpoch);
    assert.equal(sessionManager.appendInternalTranscriptIfEpochMatches(session.id, oldMutationEpoch, {
      kind: "status_message",
      llmVisible: false,
      role: "assistant",
      statusType: "system",
      content: "stale",
      timestampMs: 1
    }), false);
    // Message is queued exactly once for the next generation.
    assert.equal(current.pendingMessages.length, 1);
    assert.equal(current.pendingSteerMessages.length, 0);
    const llmVisibleHistory = sessionManager.getLlmVisibleHistory(session.id);
    assert.deepEqual(llmVisibleHistory.map((item) => ({
      role: item.role,
      content: item.content
    })), [
      {
        role: "assistant",
        content: "这是打断前已经流式展示的半截回答"
      },
      {
        role: "user",
        content: "这是插入消息"
      }
    ]);
    assert.ok(persistedReasons.includes("user_message_interrupted_active_response"));
    assert.equal(debounceScheduled, 1);
    assert.equal(flushCalled, 0);
    assert.equal(sessionManager.getReplyDelivery(session.id), "web");
  });

  test("group non-mention messages do not change the session reply delivery flag", async () => {
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
        personaStore: {} as any,
        setupStore: {
          get: async () => ({ state: "ready" })
        } as any,
        globalProfileReadinessStore: {
          get: async () => ({ persona: "ready", rp: "ready", scenario: "ready" })
        } as any,
        rpProfileStore: {} as any,
        scenarioProfileStore: {} as any,
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
    const transcript = sessionManager.getSessionView(session.id).internalTranscript;
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0]?.kind, "user_message");
    assert.equal(transcript[0]?.runtimeVisibility, "ambient");
    assert.equal(sessionManager.getLlmVisibleHistory(session.id).length, 0);
  });

  test("group mention from another user is queued without interrupting an active response", async () => {
    const config = createTestAppConfig({
      whitelist: {
        enabled: false
      }
    });
    const sessionManager = new SessionManager(config);
    const session = sessionManager.ensureSession({ id: "qqbot:g:20001", type: "group" });
    const started = sessionManager.beginSyntheticGeneration(session.id);
    assert.equal(sessionManager.setActiveAssistantDraftResponseIfResponseEpochMatches(
      session.id,
      started.responseEpoch,
      {
        chatType: "group",
        userId: "u1",
        senderName: "Alice"
      },
      "正在回复 Alice",
      20
    ), true);

    const persistedReasons: string[] = [];
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
            return { internalUserId: "u_test_user_2" };
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
        personaStore: {} as any,
        setupStore: {
          get: async () => ({ state: "ready" })
        } as any,
        globalProfileReadinessStore: {
          get: async () => ({ persona: "ready", rp: "ready", scenario: "ready" })
        } as any,
        rpProfileStore: {} as any,
        scenarioProfileStore: {} as any,
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
        throw new Error("should not flush while active response is still running");
      }
    }, {
      chatType: "group",
      userId: "u2",
      groupId: "20001",
      senderName: "Bob",
      text: "@bot 另一个问题",
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

    const current = sessionManager.getSession(session.id);
    assert.equal(started.abortController.signal.aborted, false);
    assert.equal(started.responseAbortController.signal.aborted, false);
    assert.equal(sessionManager.hasActiveResponse(session.id), true);
    assert.equal(current.pendingMessages.length, 1);
    assert.equal(current.pendingMessages[0]?.userId, "u_test_user_2");
    assert.equal(current.pendingMessages[0]?.senderName, "Bob");
    assert.equal(debounceScheduled, 0);
    assert.ok(persistedReasons.includes("group_message_queued_next_thread"));
  });

  test("same trigger user wait_more during active response is queued without scheduling a parallel flush", async () => {
    const config = createTestAppConfig({
      whitelist: {
        enabled: false
      }
    });
    const sessionManager = new SessionManager(config);
    const session = sessionManager.ensureSession({ id: "qqbot:g:20001", type: "group" });
    sessionManager.setInterruptibleGroupTriggerUser(session.id, "u_test_user_1");
    const started = sessionManager.beginSyntheticGeneration(session.id);
    assert.equal(sessionManager.setActiveAssistantDraftResponseIfResponseEpochMatches(
      session.id,
      started.responseEpoch,
      {
        chatType: "group",
        userId: "u_test_user_1",
        senderName: "Alice"
      },
      "正在回复 Alice",
      20
    ), true);

    const persistedReasons: string[] = [];
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
            return { internalUserId: "u_test_user_1" };
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
        personaStore: {} as any,
        setupStore: {
          get: async () => ({ state: "ready" })
        } as any,
        globalProfileReadinessStore: {
          get: async () => ({ persona: "ready", rp: "ready", scenario: "ready" })
        } as any,
        rpProfileStore: {} as any,
        scenarioProfileStore: {} as any,
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
        throw new Error("should not flush while active response is still running");
      }
    }, {
      chatType: "group",
      userId: "u1",
      groupId: "20001",
      senderName: "Alice",
      text: "等下我还没说完",
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
    assert.equal(started.abortController.signal.aborted, false);
    assert.equal(started.responseAbortController.signal.aborted, false);
    assert.equal(sessionManager.hasActiveResponse(session.id), true);
    assert.equal(current.pendingMessages.length, 1);
    assert.equal(debounceScheduled, 0);
    assert.ok(persistedReasons.includes("group_message_wait_more"));
  });

  test("group mention trigger updates the session reply delivery flag", async () => {
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
        personaStore: {} as any,
        setupStore: {
          get: async () => ({ state: "ready" })
        } as any,
        globalProfileReadinessStore: {
          get: async () => ({ persona: "ready", rp: "ready", scenario: "ready" })
        } as any,
        rpProfileStore: {} as any,
        scenarioProfileStore: {} as any,
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

  test("owner group mention triggers even when the group is not whitelisted", async () => {
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
        personaStore: {} as any,
        setupStore: {
          get: async () => ({ state: "ready" })
        } as any,
        globalProfileReadinessStore: {
          get: async () => ({ persona: "ready", rp: "ready", scenario: "ready" })
        } as any,
        rpProfileStore: {} as any,
        scenarioProfileStore: {} as any,
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
