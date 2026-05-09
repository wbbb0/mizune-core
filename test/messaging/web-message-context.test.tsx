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

  test("onebot message context does not auto-download NapCat file attachments", async () => {
    const incomingMessage: ParsedIncomingMessage = {
      chatType: "private",
      userId: "2254600711",
      senderName: "Alice",
      text: "",
      images: [],
      audioSources: [],
      audioIds: [],
      emojiSources: [],
      imageIds: [],
      emojiIds: [],
      attachments: [],
      messageFiles: [{
        fileId: "onebot-file-1",
        name: "铅毒之果.pdf",
        busid: null,
        sizeBytes: 3673240,
        mimeType: null,
        downloadTool: "download_message_file"
      }],
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      isAtMentioned: false,
      rawEvent: {
        post_type: "message",
        message_type: "private",
        sub_type: "friend",
        message_id: 123,
        user_id: 2254600711,
        message: [{
          type: "file",
          data: {
            file: "铅毒之果.pdf",
            file_id: "onebot-file-1",
            file_size: 3673240
          }
        }],
        raw_message: "",
        sender: { user_id: 2254600711, nickname: "Alice" },
        self_id: 10000,
        time: 1
      }
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
            internalUserId: "u_01TESTUSER000000000000002",
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
        async importRemoteSource() {
          throw new Error("message files should be downloaded only after download_message_file is called");
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

    assert.deepEqual(context.enrichedMessage.attachments, []);
    assert.deepEqual(context.enrichedMessage.messageFiles, [{
      fileId: "onebot-file-1",
      name: "铅毒之果.pdf",
      busid: null,
      sizeBytes: 3673240,
      mimeType: null,
      downloadTool: "download_message_file"
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

  test("onebot message context replaces pending media placeholders with imported assets", async () => {
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

  test("onebot message context resolves content part media in place", async () => {
    const incomingMessage: ParsedIncomingMessage = {
      chatType: "private",
      userId: "2254600711",
      senderName: "Alice",
      text: "前后",
      contentParts: [
        { kind: "text", text: "前" },
        { kind: "image", source: "https://example.com/pic.png" },
        { kind: "text", text: "后" }
      ],
      images: ["https://example.com/pic.png"],
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
            internalUserId: "u_01TESTUSER000000000000003",
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
          assert.equal(input.source, "https://example.com/pic.png");
          assert.equal(input.sourceContext.mediaKind, "image");
          return {
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

    assert.deepEqual(context.enrichedMessage.contentParts, [
      { kind: "text", text: "前" },
      { kind: "image", fileId: "file_image_1", sourceName: "pic.png", mimeType: "image/png" },
      { kind: "text", text: "后" }
    ]);
  });

  test("onebot message context maps duplicate audio content parts to the same registered audio id", async () => {
    const incomingMessage: ParsedIncomingMessage = {
      chatType: "private",
      userId: "2254600711",
      senderName: "Alice",
      text: "",
      contentParts: [
        { kind: "audio", source: "voice.amr" },
        { kind: "text", text: "再发一次" },
        { kind: "audio", source: "voice.amr" }
      ],
      images: [],
      audioSources: ["voice.amr"],
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
            internalUserId: "u_01TESTUSER000000000000004",
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
        async registerSources(sources: string[]) {
          assert.deepEqual(sources, ["voice.amr"]);
          return [{
            id: "aud-1",
            source: "voice.amr",
            createdAt: 1,
            transcription: null,
            transcriptionStatus: "missing",
            transcriptionModelRef: null,
            transcriptionError: null
          }];
        }
      } as never,
      chatFileStore: {
        async importRemoteSource() {
          throw new Error("should not import remote assets for audio-only messages");
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

    assert.deepEqual(context.enrichedMessage.audioIds, ["aud-1"]);
    assert.deepEqual(context.enrichedMessage.contentParts, [
      { kind: "audio", source: "voice.amr", audioId: "aud-1" },
      { kind: "text", text: "再发一次" },
      { kind: "audio", source: "voice.amr", audioId: "aud-1" }
    ]);
  });
