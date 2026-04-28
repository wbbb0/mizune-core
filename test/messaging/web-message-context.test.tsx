import test from "node:test";
import assert from "node:assert/strict";
import { createMessageProcessingContext } from "../../src/app/messaging/messageContextBuilder.ts";
import type { ParsedIncomingMessage } from "../../src/services/onebot/types.ts";

  test("web message context preserves pre-resolved attachments and image ids", async () => {
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
      userIdentityStore: {
        async ensureUserIdentity() {
          throw new Error("web message context should not resolve external identities");
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
      targetSessionId: "web:test",
      delivery: "web"
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

  test("onebot message context resolves external users into internal user ids", async () => {
    const incomingMessage: ParsedIncomingMessage = {
      chatType: "private",
      userId: "2254600711",
      senderName: "Alice",
      text: "你好",
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
    };

    const context = await createMessageProcessingContext({
      setupStore: {
        async get() {
          return { phase: "ready" };
        }
      } as never,
      userIdentityStore: {
        async ensureUserIdentity() {
          return {
            channelId: "qqbot",
            scope: "private_user",
            externalId: "2254600711",
            internalUserId: "u_01TESTUSER000000000000000",
            createdAt: 1
          };
        }
      } as never,
      userStore: {
        async touchSeenUser({ userId }: { userId: string }) {
          assert.equal(userId, "u_01TESTUSER000000000000000");
          return { userId, relationship: "known" };
        }
      } as never,
      audioStore: {
        async registerSources() {
          return [];
        }
      } as never,
      chatFileStore: {
        async importRemoteSource() {
          throw new Error("should not import remote assets for text-only messages");
        }
      } as never,
      sessionManager: {
        getOrCreateSession(message: ParsedIncomingMessage) {
          assert.equal(message.userId, "u_01TESTUSER000000000000000");
          return { id: "qqbot:p:2254600711", type: "private" } as never;
        }
      } as never
    }, incomingMessage, {
      delivery: "onebot"
    });

    assert.equal(context.enrichedMessage.userId, "u_01TESTUSER000000000000000");
  });

  test("onebot message context replaces pending media placeholders with imported chat files", async () => {
    const incomingMessage: ParsedIncomingMessage = {
      chatType: "private",
      userId: "2254600711",
      senderName: "Alice",
      text: "",
      images: ["https://example.com/emoji.gif", "https://example.com/pic.png"],
      audioSources: [],
      audioIds: [],
      emojiSources: ["https://example.com/emoji.gif"],
      imageIds: ["pending:image:1:https://example.com/pic.png"],
      emojiIds: [],
      attachments: [{
        fileId: "pending:image:0:https://example.com/emoji.gif",
        kind: "image",
        source: "chat_message",
        sourceName: null,
        mimeType: null
      }],
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      isAtMentioned: false
    };

    const context = await createMessageProcessingContext({
      setupStore: {
        async get() {
          return { phase: "ready" };
        }
      } as never,
      userIdentityStore: {
        async ensureUserIdentity() {
          return {
            channelId: "qqbot",
            scope: "private_user",
            externalId: "2254600711",
            internalUserId: "u_01TESTUSER000000000000001",
            createdAt: 1
          };
        }
      } as never,
      userStore: {
        async touchSeenUser() {
          return { relationship: "known" };
        }
      } as never,
      audioStore: {
        async registerSources() {
          return [];
        }
      } as never,
      chatFileStore: {
        async importRemoteSource(input: { source: string; sourceContext: { mediaKind: "image" | "emoji" } }) {
          return input.source.includes("emoji")
            ? {
                fileId: "file_emoji_1",
                kind: "animated_image",
                sourceName: "emoji.gif",
                mimeType: "image/gif",
                sourceContext: input.sourceContext
              }
            : {
                fileId: "file_image_1",
                kind: "image",
                sourceName: "pic.png",
                mimeType: "image/png",
                sourceContext: input.sourceContext
              };
        }
      } as never,
      sessionManager: {
        getOrCreateSession() {
          return { id: "qqbot:p:2254600711", type: "private" } as never;
        }
      } as never
    }, incomingMessage, {
      delivery: "onebot"
    });

    assert.deepEqual(context.enrichedMessage.imageIds, ["file_image_1"]);
    assert.deepEqual(context.enrichedMessage.emojiIds, ["file_emoji_1"]);
    assert.deepEqual(context.enrichedMessage.attachments, [{
      fileId: "file_emoji_1",
      kind: "animated_image",
      source: "chat_message",
      sourceName: "emoji.gif",
      mimeType: "image/gif",
      semanticKind: "emoji"
    }, {
      fileId: "file_image_1",
      kind: "image",
      source: "chat_message",
      sourceName: "pic.png",
      mimeType: "image/png",
      semanticKind: "image"
    }]);
  });
