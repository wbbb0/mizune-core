import test from "node:test";
import assert from "node:assert/strict";
import {
  createUserTranscriptMessageItem,
  projectTranscriptMessageItemToHistoryMessage
} from "../../src/conversation/session/historyContext.ts";

test("history projection skips pending media ids and dedupes attachment refs", () => {
  const item = createUserTranscriptMessageItem({
    chatType: "private",
    userId: "10001",
    senderName: "Alice",
    text: "",
    imageIds: ["file_image_1", "pending:image:0:https://example.com/a.png"],
    emojiIds: ["file_emoji_1"],
    attachments: [{
      fileId: "pending:image:0:https://example.com/a.png",
      kind: "image",
      source: "chat_message",
      sourceName: null,
      mimeType: null
    }, {
      fileId: "file_image_1",
      kind: "image",
      source: "chat_message",
      sourceName: "a.png",
      mimeType: "image/png",
      semanticKind: "image"
    }, {
      fileId: "file_emoji_1",
      kind: "animated_image",
      source: "chat_message",
      sourceName: "emoji.gif",
      mimeType: "image/gif",
      semanticKind: "emoji"
    }],
    timestampMs: 1710000000000
  });

  const projected = projectTranscriptMessageItemToHistoryMessage(item);

  assert.equal(projected.content.includes("pending:image"), false);
  assert.equal(countOccurrences(projected.content, "file_image_1"), 1);
  assert.equal(countOccurrences(projected.content, "file_emoji_1"), 1);
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
