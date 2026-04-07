import assert from "node:assert/strict";
import { createAdminMessagingService } from "../src/internalApi/application/messagingAdminService.ts";
import type { InternalTranscriptItem } from "../src/conversation/session/sessionTypes.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  await runCase("session stream sends catch-up transcript events", async () => {
    const transcript: InternalTranscriptItem[] = [{
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
      pendingMessages: [{ receivedAt: 1 }],
      pendingReplyGateWaitPasses: 0,
      debounceTimer: null,
      isGenerating: true,
      isResponding: false,
      historyRevision: 3,
      mutationEpoch: 7,
      lastActiveAt: 99,
      internalTranscript: transcript,
      recentToolEvents: [] as Array<{ toolName: string }>,
      activeAssistantResponse: null
    };

    const service = createAdminMessagingService({
      oneBotClient: {
        async sendText() {
          return {};
        }
      } as any,
      mediaWorkspace: {
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
        }
      } as any,
      async handleWebIncomingMessage() {}
    });

    const stream = await service.getWebSessionStream(
      { sessionId: "private:10001" },
      { mutationEpoch: 7, transcriptCount: 0 }
    );

    assert.deepEqual(stream.initialEvents.map((event) => event.type), ["ready", "transcript_item"]);
    const transcriptEvent = stream.initialEvents[1];
    assert.equal(transcriptEvent?.type, "transcript_item");
    if (transcriptEvent?.type === "transcript_item") {
      assert.equal(transcriptEvent.totalCount, 1);
      assert.equal(transcriptEvent.index, 0);
      assert.deepEqual(transcriptEvent.item, transcript[0]);
    }
  });

  await runCase("session stream emits transcript items incrementally", async () => {
    const sessionState = {
      id: "private:10001",
      type: "private" as const,
      pendingMessages: [] as Array<{ receivedAt?: number }>,
      pendingReplyGateWaitPasses: 0,
      debounceTimer: null,
      isGenerating: true,
      isResponding: false,
      historyRevision: 1,
      mutationEpoch: 2,
      lastActiveAt: 100,
      internalTranscript: [] as InternalTranscriptItem[],
      recentToolEvents: [] as Array<{ toolName: string }>,
      activeAssistantResponse: null
    };

    const service = createAdminMessagingService({
      oneBotClient: {
        async sendText() {
          return {};
        }
      } as any,
      mediaWorkspace: {
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
        }
      } as any,
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
    sessionState.isGenerating = false;
    sessionState.lastActiveAt = 130;
    await sleep(320);

    unsubscribe();

    assert.ok(receivedTypes.includes("transcript_item"));
    const transcriptEvent = receivedEvents.find((event) => event.type === "transcript_item");
    assert.equal(transcriptEvent?.totalCount, 1);
    assert.equal(transcriptEvent?.index, 0);
    assert.deepEqual(transcriptEvent?.item, {
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
