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

    assert.equal(items.length, 3);
    assert.equal(items[0]?.kind, "text");
    assert.equal(items[0]?.metaChips, undefined);

    assert.equal(items[1]?.kind, "image");
    assert.equal(items[1]?.role, "user");
    assert.equal(items[1]?.imageUrl, "/api/chat-files/img-attachment/content");
    assert.equal(items[1]?.sourceName, "upload_image.png");

    assert.equal(items[2]?.kind, "image");
    assert.equal(items[2]?.role, "user");
    assert.equal(items[2]?.imageUrl, "/api/chat-files/img-fallback/content");
    assert.equal(items[2]?.sourceName, null);
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
        toolName: "chat_file_send_to_chat",
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
    assert.equal(items[0]?.streaming, true);
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
