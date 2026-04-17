import assert from "node:assert/strict";
import { createAdminMessagingService } from "../../src/internalApi/application/messagingAdminService.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import type { InternalTranscriptItem, TranscriptAssistantMessageItem } from "../../src/conversation/session/sessionTypes.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

function nextTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function main() {
  await runCase("session stream sends catch-up transcript events", async () => {
    const transcript: InternalTranscriptItem[] = [{
      id: "item-1",
      groupId: "group-1",
      invalidated: false,
      kind: "user_message",
      role: "user",
      llmVisible: true,
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text: "hello",
      imageIds: [],
      emojiIds: [],
      attachments: [],
      audioCount: 0,
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      mentionedSelf: false,
      timestampMs: 1
    }];
    const sessionState = {
      id: "private:10001",
      type: "private" as const,
      source: "onebot" as const,
      participantUserId: "10001",
      phase: { kind: "idle" },
      pendingMessages: [{ receivedAt: 1 }],
      historyRevision: 1,
      mutationEpoch: 7,
      lastActiveAt: 99,
      internalTranscript: transcript,
      recentToolEvents: [] as Array<{ toolName: string }>,
      activeAssistantResponse: null
    };

    const service = createAdminMessagingService({
      config: {
        onebot: {
          enabled: true
        }
      },
      oneBotClient: {
        async sendText() {
          return {};
        }
      } as any,
      chatFileStore: {
        async getMany() {
          return [];
        }
      } as any,
      sessionManager: {
        getSession() {
          return sessionState;
        },
        hasActiveResponse() {
          return false;
        },
        subscribeSession() {
          return () => {};
        }
      } as any,
      async handleWebIncomingMessage() {}
    });

    const stream = await service.getWebSessionStream(
      { sessionId: "private:10001" },
      { mutationEpoch: 7, transcriptCount: 0 }
    );

    assert.deepEqual(stream.initialEvents.map((event) => event.type), ["ready", "transcript_item_added"]);
    const transcriptEvent = stream.initialEvents[1];
    assert.equal(transcriptEvent?.type, "transcript_item_added");
    if (transcriptEvent?.type === "transcript_item_added") {
      assert.equal(transcriptEvent.totalCount, 1);
      assert.equal(transcriptEvent.index, 0);
      assert.deepEqual(transcriptEvent.item, transcript[0]);
    }
  });

  await runCase("session stream emits transcript items incrementally", async () => {
    const sessionState = {
      id: "private:10001",
      type: "private" as const,
      source: "onebot" as const,
      participantUserId: "10001",
      participantLabel: "Alice",
      phase: { kind: "idle" },
      pendingMessages: [] as Array<{ receivedAt?: number }>,
      historyRevision: 1,
      mutationEpoch: 2,
      lastActiveAt: 100,
      internalTranscript: [] as InternalTranscriptItem[],
      recentToolEvents: [] as Array<{ toolName: string }>,
      activeAssistantResponse: null
    };

    const sessionManager = {
      __listener: null as null | (() => void),
      getSession() {
        return sessionState;
      },
      hasActiveResponse() {
        return false;
      },
      subscribeSession(_sessionId: string, listener: () => void) {
        this.__listener = listener;
        return () => {
          this.__listener = null;
        };
      }
    };

    const service = createAdminMessagingService({
      config: {
        onebot: {
          enabled: true
        }
      },
      oneBotClient: {
        async sendText() {
          return {};
        }
      } as any,
      chatFileStore: {
        async getMany() {
          return [];
        }
      } as any,
      sessionManager: sessionManager as any,
      async handleWebIncomingMessage() {}
    });

    const stream = await service.getWebSessionStream(
      { sessionId: "private:10001" },
      { mutationEpoch: 2, transcriptCount: 0 }
    );
    const receivedTypes: string[] = [];
    const receivedEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const unsubscribe = stream.subscribe((event) => {
      receivedTypes.push(event.type);
      receivedEvents.push(event as { type: string; [key: string]: unknown });
    });

    sessionState.internalTranscript.push({
      id: "item-1",
      groupId: "group-1",
      invalidated: false,
      kind: "assistant_message",
      role: "assistant",
      llmVisible: true,
      chatType: "private",
      userId: "10001",
      senderName: "10001",
      text: "AB",
      timestampMs: 30
    });
    sessionState.historyRevision = 2;
    sessionState.lastActiveAt = 130;
    sessionManager.__listener?.();
    await nextTick();

    unsubscribe();

    assert.ok(receivedTypes.includes("transcript_item_added"));
    const transcriptEvent = receivedEvents.find((event) => event.type === "transcript_item_added");
    assert.equal(transcriptEvent?.totalCount, 1);
    assert.equal(transcriptEvent?.index, 0);
    assert.deepEqual(transcriptEvent?.item, {
      id: "item-1",
      groupId: "group-1",
      invalidated: false,
      kind: "assistant_message",
      role: "assistant",
      llmVisible: true,
      chatType: "private",
      userId: "10001",
      senderName: "10001",
      text: "AB",
      timestampMs: 30
    });
  });

  await runCase("session stream emits transcript item patches for reasoning updates", async () => {
    const sessionState = {
      id: "private:10001",
      type: "private" as const,
      source: "onebot" as const,
      participantUserId: "10001",
      participantLabel: "Alice",
      phase: { kind: "idle" },
      pendingMessages: [] as Array<{ receivedAt?: number }>,
      historyRevision: 1,
      mutationEpoch: 2,
      lastActiveAt: 100,
      internalTranscript: [{
        id: "item-1",
        groupId: "group-1",
        invalidated: false,
        kind: "assistant_message" as const,
        role: "assistant" as const,
        llmVisible: true as const,
        chatType: "private" as const,
        userId: "10001",
        senderName: "10001",
        text: "AB",
        timestampMs: 30
      }] as TranscriptAssistantMessageItem[],
      recentToolEvents: [] as Array<{ toolName: string }>,
      activeAssistantResponse: null
    };

    const sessionManager = {
      __listener: null as null | (() => void),
      getSession() {
        return sessionState;
      },
      hasActiveResponse() {
        return false;
      },
      subscribeSession(_sessionId: string, listener: () => void) {
        this.__listener = listener;
        return () => {
          this.__listener = null;
        };
      }
    };

    const service = createAdminMessagingService({
      config: {
        onebot: {
          enabled: true
        }
      },
      oneBotClient: {
        async sendText() {
          return {};
        }
      } as any,
      chatFileStore: {
        async getMany() {
          return [];
        }
      } as any,
      sessionManager: sessionManager as any,
      async handleWebIncomingMessage() {}
    });

    const stream = await service.getWebSessionStream(
      { sessionId: "private:10001" },
      { mutationEpoch: 2, transcriptCount: 1 }
    );
    const receivedEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const unsubscribe = stream.subscribe((event) => {
      receivedEvents.push(event as { type: string; [key: string]: unknown });
    });

    sessionState.internalTranscript[0] = {
      ...sessionState.internalTranscript[0],
      reasoningContent: "thoughts"
    } as TranscriptAssistantMessageItem;
    sessionManager.__listener?.();
    await nextTick();

    unsubscribe();

    assert.deepEqual(receivedEvents, [{
      type: "transcript_item_patched",
      sessionId: "private:10001",
      mutationEpoch: 2,
      itemId: "item-1",
      patch: {
        reasoningContent: "thoughts"
      },
      timestampMs: receivedEvents[0]?.timestampMs
    }]);
    assert.equal(typeof receivedEvents[0]?.timestampMs, "number");
  });

  await runCase("session stream emits session_error when subscribed session is deleted", async () => {
    const sessionId = "web:session-stream-delete";
    const sessionManager = new SessionManager(createTestAppConfig());
    sessionManager.ensureSession({
      id: sessionId,
      type: "private",
      source: "web",
      participantUserId: "10001",
      participantLabel: "Alice"
    });

    const service = createAdminMessagingService({
      config: {
        onebot: {
          enabled: true
        }
      },
      oneBotClient: {
        async sendText() {
          return {};
        }
      } as any,
      chatFileStore: {
        async getMany() {
          return [];
        }
      } as any,
      sessionManager,
      async handleWebIncomingMessage() {}
    });

    const stream = await service.getWebSessionStream(
      { sessionId },
      { mutationEpoch: 0, transcriptCount: 0 }
    );
    const receivedEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const unsubscribe = stream.subscribe((event) => {
      receivedEvents.push(event as { type: string; [key: string]: unknown });
    });

    assert.doesNotThrow(() => {
      sessionManager.deleteSession(sessionId);
    });
    await nextTick();

    unsubscribe();

    const sessionErrorEvent = receivedEvents.find((event) => event.type === "session_error");
    assert.equal(sessionErrorEvent?.type, "session_error");
    assert.match(String(sessionErrorEvent?.message), /Session not found:/);
  });

  await runCase("web turn emits turn_error when session is deleted before completion", async () => {
    const sessionId = "web:web-turn-delete";
    const sessionManager = new SessionManager(createTestAppConfig());
    sessionManager.ensureSession({
      id: sessionId,
      type: "private",
      source: "web",
      participantUserId: "10001",
      participantLabel: "Alice"
    });

    const service = createAdminMessagingService({
      config: {
        onebot: {
          enabled: true
        }
      },
      oneBotClient: {
        async sendText() {
          return {};
        }
      } as any,
      chatFileStore: {
        async getMany() {
          return [];
        }
      } as any,
      sessionManager,
      async handleWebIncomingMessage() {
        sessionManager.deleteSession(sessionId);
      }
    });

    const { turnId } = await service.startWebSessionTurn(
      { sessionId },
      {
        userId: "10001",
        senderName: "Alice",
        text: "hello",
        imageIds: [],
        attachmentIds: []
      }
    );
    const stream = service.getWebTurnStream({ sessionId }, { turnId });
    const terminalEvent = await new Promise<{ type: string; [key: string]: unknown }>((resolve) => {
      const unsubscribe = stream.subscribe((event) => {
        if (event.type !== "turn_error" && event.type !== "complete") {
          return;
        }
        unsubscribe();
        resolve(event as { type: string; [key: string]: unknown });
      });
    });

    assert.equal(terminalEvent.type, "turn_error");
    assert.match(String(terminalEvent.message), /Session was deleted before session response completed/);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
