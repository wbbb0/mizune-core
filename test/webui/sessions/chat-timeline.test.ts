import test from "node:test";
import assert from "node:assert/strict";
import { buildChatTimelineItems } from "../../../webui/src/components/sessions/chatTimeline.ts";
import type { ChatTimelineTranscriptEntry } from "../../../webui/src/components/sessions/chatTimeline.ts";

function createUserMessageEntry(): ChatTimelineTranscriptEntry {
  return {
    id: "entry-user-1",
    eventId: "event-user-1",
    index: 0,
    item: {
      id: "item-user-1",
      groupId: "group-user-1",
      runtimeExcluded: false,
      kind: "user_message",
      role: "user",
      llmVisible: true,
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text: "图片在下面",
      imageIds: ["img-attachment", "img-fallback"],
      emojiIds: [],
      attachments: [{
        fileId: "img-attachment",
        kind: "image",
        source: "web_upload",
        sourceName: "upload_image.png",
        mimeType: "image/png",
        semanticKind: "image"
      }, {
        fileId: "emoji-1",
        kind: "image",
        source: "chat_message",
        sourceName: "emoji.gif",
        mimeType: "image/gif",
        semanticKind: "emoji"
      }, {
        fileId: "note-1",
        kind: "file",
        source: "web_upload",
        sourceName: "note.txt",
        mimeType: "text/plain"
      }],
      messageFiles: [],
      audioCount: 0,
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      mentionedSelf: false,
      timestampMs: 1710000000000
    }
  };
}

  test("chat timeline expands user message images into dedicated image cards", () => {
    const items = buildChatTimelineItems([createUserMessageEntry()], {
      activeComposerUserId: "10001"
    });

    assert.equal(items.length, 4);
    assert.equal(items[0]?.kind, "text");
    assert.equal(items[0]?.metaChips, undefined);

    assert.equal(items[1]?.kind, "image");
    assert.equal(items[1]?.role, "user");
    assert.equal(items[1]?.imageUrl, "/api/chat-files/img-attachment/content");
    assert.equal(items[1]?.sourceName, "upload_image.png");
    assert.equal(items[1]?.senderLabel, "Alice · 10001");

    assert.equal(items[2]?.kind, "image");
    assert.equal(items[2]?.role, "user");
    assert.equal(items[2]?.imageUrl, "/api/chat-files/emoji-1/content");
    assert.equal(items[2]?.sourceName, "emoji.gif");
    assert.equal(items[2]?.senderLabel, "Alice · 10001");

    assert.equal(items[3]?.kind, "image");
    assert.equal(items[3]?.role, "user");
    assert.equal(items[3]?.imageUrl, "/api/chat-files/img-fallback/content");
    assert.equal(items[3]?.sourceName, null);
  });

  test("chat timeline keeps outbound media messages available in reverse chronological order", () => {
    const items = buildChatTimelineItems([createUserMessageEntry(), {
      id: "entry-media-1",
      eventId: "event-media-1",
      index: 1,
      item: {
        id: "item-media-1",
        groupId: "group-media-1",
        runtimeExcluded: false,
        kind: "outbound_media_message",
        llmVisible: false,
        role: "assistant",
        delivery: "onebot",
        mediaKind: "image",
        fileId: "assistant-image-1",
        fileRef: "assistant.png",
        sourceName: "assistant.png",
        chatFilePath: "workspace/media/assistant.png",
        sourcePath: null,
        messageId: 12,
        toolName: "asset_send_to_chat",
        timestampMs: 1710000001000
      }
    }], {
      activeComposerUserId: "10001"
    });

    const firstItem = items[0];
    assert.equal(firstItem?.kind, "image");
    assert.equal(firstItem?.role, "assistant");
    if (firstItem?.kind !== "image") {
      throw new Error("expected image item");
    }
    assert.equal(firstItem.imageUrl, "/api/chat-files/assistant-image-1/content");
  });

  test("chat timeline renders outbound file messages as downloadable file parts", () => {
    const items = buildChatTimelineItems([{
      id: "entry-file-1",
      eventId: "event-file-1",
      index: 0,
      item: {
        id: "item-file-1",
        groupId: "group-file-1",
        runtimeExcluded: false,
        kind: "outbound_media_message",
        llmVisible: false,
        role: "assistant",
        delivery: "web",
        mediaKind: "file",
        fileId: "assistant-file-1",
        fileRef: "report.pdf",
        sourceName: "report.pdf",
        chatFilePath: "workspace/media/report.pdf",
        sourcePath: null,
        mimeType: "application/pdf",
        sizeBytes: 42,
        messageId: null,
        toolName: "asset_send_to_chat",
        timestampMs: 1710000001000
      }
    }]);

    const firstItem = items[0];
    assert.equal(firstItem?.kind, "content_parts");
    assert.equal(firstItem?.role, "assistant");
    if (firstItem?.kind !== "content_parts") {
      throw new Error("expected content parts item");
    }
    assert.deepEqual(firstItem.parts, [{
      kind: "file",
      fileId: "assistant-file-1",
      name: "report.pdf",
      sizeBytes: 42,
      mimeType: "application/pdf",
      fileKind: "file",
      contentUrl: "/api/chat-files/assistant-file-1/content"
    }]);
    assert.deepEqual(firstItem.metaChips, ["asset_send_to_chat"]);
  });

  test("chat timeline renders special-only user message segments as text", () => {
    const entry = createUserMessageEntry();
    if (entry.item.kind !== "user_message") {
      throw new Error("expected user message");
    }
    entry.item.text = "";
    entry.item.imageIds = [];
    entry.item.attachments = [];
    entry.item.specialSegments = [{ type: "dice", summary: "骰子：4" }];

    const items = buildChatTimelineItems([entry], {
      activeComposerUserId: "10001"
    });

    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "text");
    assert.equal(items[0]?.content, "骰子：4");
    assert.deepEqual(items[0]?.metaChips, ["消息段 1"]);
  });

  test("chat timeline renders structured file messages as text metadata", () => {
    const entry = createUserMessageEntry();
    if (entry.item.kind !== "user_message") {
      throw new Error("expected user message");
    }
    entry.item.text = "";
    entry.item.imageIds = [];
    entry.item.attachments = [];
    entry.item.messageFiles = [{
      fileId: "onebot-file-1",
      name: "report.pdf",
      busid: null,
      sizeBytes: 1234,
      mimeType: "application/pdf",
      downloadTool: "download_message_file"
    }];

    const items = buildChatTimelineItems([entry], {
      activeComposerUserId: "10001"
    });

    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "text");
    assert.equal(items[0]?.content, "文件：report.pdf");
    assert.deepEqual(items[0]?.metaChips, ["文件 1"]);
  });

  test("chat timeline renders mixed content parts in one ordered user bubble", () => {
    const entry = createUserMessageEntry();
    if (entry.item.kind !== "user_message") {
      throw new Error("expected user message");
    }
    entry.item.contentParts = [
      { kind: "text", text: "前" },
      { kind: "image", fileId: "img-1", sourceName: "a.png", mimeType: "image/png" },
      { kind: "asset_file", fileId: "file-1", fileKind: "file", sourceName: "note.txt", mimeType: "text/plain", sizeBytes: 32 },
      { kind: "text", text: "后" }
    ];
    entry.item.imageIds = ["img-1"];
    entry.item.attachments = [];

    const items = buildChatTimelineItems([entry], {
      activeComposerUserId: "10001"
    });

    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "content_parts");
    if (items[0]?.kind !== "content_parts") {
      throw new Error("expected content parts item");
    }
    assert.deepEqual(items[0].parts, [
      { kind: "text", text: "前" },
      { kind: "image", fileId: "img-1", imageUrl: "/api/chat-files/img-1/content", sourceName: "a.png" },
      { kind: "file", fileId: "file-1", name: "note.txt", sizeBytes: 32, mimeType: "text/plain", fileKind: "file", contentUrl: "/api/chat-files/file-1/content" },
      { kind: "text", text: "后" }
    ]);
  });

  test("chat timeline keeps unresolved media content parts visible", () => {
    const entry = createUserMessageEntry();
    if (entry.item.kind !== "user_message") {
      throw new Error("expected user message");
    }
    entry.item.contentParts = [
      { kind: "text", text: "前" },
      { kind: "image", source: "https://example.com/a.png" },
      { kind: "emoji", fileId: "pending:emoji:0:https://example.com/e.gif", sourceName: "e.gif" }
    ];
    entry.item.imageIds = [];
    entry.item.attachments = [];

    const items = buildChatTimelineItems([entry], {
      activeComposerUserId: "10001"
    });

    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "content_parts");
    if (items[0]?.kind !== "content_parts") {
      throw new Error("expected content parts item");
    }
    assert.deepEqual(items[0].parts, [
      { kind: "text", text: "前" },
      { kind: "meta", text: "图片待解析：https://example.com/a.png" },
      { kind: "meta", text: "表情待解析：e.gif" }
    ]);
  });

  test("chat timeline preserves audio order inside mixed content parts", () => {
    const entry = createUserMessageEntry();
    if (entry.item.kind !== "user_message") {
      throw new Error("expected user message");
    }
    entry.item.contentParts = [
      { kind: "text", text: "前" },
      { kind: "audio", source: "voice.amr", audioId: "aud-1" },
      { kind: "image", fileId: "img-1", sourceName: "a.png", mimeType: "image/png" },
      { kind: "asset_file", fileId: "file-1", fileKind: "file", sourceName: "note.txt", mimeType: "text/plain", sizeBytes: 32 },
      { kind: "text", text: "后" }
    ];
    entry.item.imageIds = ["img-1"];
    entry.item.attachments = [];

    const items = buildChatTimelineItems([entry], {
      activeComposerUserId: "10001"
    });

    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "content_parts");
    if (items[0]?.kind !== "content_parts") {
      throw new Error("expected content parts item");
    }
    assert.deepEqual(items[0].parts, [
      { kind: "text", text: "前" },
      { kind: "meta", text: "语音消息" },
      { kind: "image", fileId: "img-1", imageUrl: "/api/chat-files/img-1/content", sourceName: "a.png" },
      { kind: "file", fileId: "file-1", name: "note.txt", sizeBytes: 32, mimeType: "text/plain", fileKind: "file", contentUrl: "/api/chat-files/file-1/content" },
      { kind: "text", text: "后" }
    ]);
  });

  test("chat timeline renders user media transcript items as content part bubbles", () => {
    const items = buildChatTimelineItems([{
      id: "entry-media-user-1",
      eventId: "event-media-user-1",
      index: 0,
      item: {
        id: "item-media-user-1",
        groupId: "group-media-user-1",
        runtimeExcluded: false,
        kind: "user_media_message",
        role: "user",
        llmVisible: true,
        chatType: "private",
        userId: "10001",
        senderName: "Alice",
        mediaKind: "emoji",
        contentParts: [{ kind: "emoji", fileId: "emoji-1", sourceName: "e.gif", mimeType: "image/gif" }],
        imageIds: [],
        emojiIds: ["emoji-1"],
        attachments: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        mentionedSelf: false,
        timestampMs: 1710000000000
      }
    }], {
      activeComposerUserId: "10001"
    });

    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "content_parts");
    if (items[0]?.kind !== "content_parts") {
      throw new Error("expected content parts item");
    }
    assert.equal(items[0].actionTitle, "表情消息");
    assert.deepEqual(items[0].parts, [{
      kind: "emoji",
      fileId: "emoji-1",
      imageUrl: "/api/chat-files/emoji-1/content",
      sourceName: "e.gif"
    }]);
  });

  test("chat timeline keeps newest items first and prepends draft assistant text to the head", () => {
    const items = buildChatTimelineItems([createUserMessageEntry(), {
      id: "entry-assistant-1",
      eventId: "event-assistant-1",
      index: 1,
      item: {
        id: "item-assistant-1",
        groupId: "group-assistant-1",
        runtimeExcluded: false,
        kind: "assistant_message",
        role: "assistant",
        llmVisible: true,
        chatType: "private",
        userId: "bot",
        senderName: "Bot",
        text: "第一条正式回复",
        timestampMs: 1710000001000
      }
    }], {
      activeComposerUserId: "10001",
      draftAssistantText: "正在流式补充"
    });

    assert.equal(items[0]?.kind, "text");
    assert.equal(items[0]?.role, "assistant");
    assert.equal(items[0]?.content, "正在流式补充");
    assert.equal(items[0]?.label, undefined);
    assert.equal(items[0]?.actionsEnabled, false);

    assert.equal(items[1]?.kind, "text");
    assert.equal(items[1]?.role, "assistant");
    assert.equal(items[1]?.content, "第一条正式回复");

    assert.equal(items[2]?.kind, "text");
    assert.equal(items[2]?.role, "user");
    assert.equal(items[2]?.content, "图片在下面");

    assert.equal(items[3]?.kind, "image");
    assert.equal(items[4]?.kind, "image");
  });
