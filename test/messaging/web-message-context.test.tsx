import assert from "node:assert/strict";
import { createMessageProcessingContext } from "../../src/app/messaging/messageContextBuilder.ts";
import type { ParsedIncomingMessage } from "../../src/services/onebot/types.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("web message context preserves pre-resolved attachments and image ids", async () => {
    const incomingMessage: ParsedIncomingMessage = {
      chatType: "private",
      userId: "2254600711",
      senderName: "assistant_1",
      text: "",
      images: [],
      audioSources: [],
      audioIds: [],
      emojiSources: [],
      imageIds: ["file_uploaded_image_1"],
      emojiIds: [],
      attachments: [{
        fileId: "file_uploaded_image_1",
        kind: "image",
        source: "web_upload",
        sourceName: "IMG_3680.jpeg",
        mimeType: "image/jpeg"
      }],
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      isAtMentioned: false
    };

    const session = {
      id: "web:test",
      type: "private"
    };

    const context = await createMessageProcessingContext({
      setupStore: {
        async get() {
          return { phase: "ready" };
        }
      } as never,
      userStore: {
        async touchSeenUser() {
          return { relationship: "owner" };
        }
      } as never,
      audioStore: {
        async registerSources() {
          return [];
        }
      } as never,
      chatFileStore: {
        async importRemoteSource() {
          throw new Error("should not import remote assets for pre-resolved web uploads");
        }
      } as never,
      sessionManager: {
        getSession(sessionId: string) {
          assert.equal(sessionId, "web:test");
          return session as never;
        }
      } as never
    }, incomingMessage, {
      targetSessionId: "web:test"
    });

    assert.deepEqual(context.enrichedMessage.imageIds, ["file_uploaded_image_1"]);
    assert.deepEqual(context.enrichedMessage.attachments, [{
      fileId: "file_uploaded_image_1",
      kind: "image",
      source: "web_upload",
      sourceName: "IMG_3680.jpeg",
      mimeType: "image/jpeg"
    }]);
  });
}

void main();
