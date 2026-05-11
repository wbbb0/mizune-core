import test from "node:test";
import assert from "node:assert/strict";
import {
  createUserTranscriptMessageItem,
  projectTranscriptMessageItemToHistoryMessage
} from "../../src/conversation/session/historyContext.ts";
import { buildTag } from "../../src/utils/structuredEnvelope.ts";

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

test("pure visual content parts create user media transcript items", () => {
  const item = createUserTranscriptMessageItem({
    chatType: "private",
    userId: "10001",
    senderName: "Alice",
    text: "",
    contentParts: [
      { kind: "image", fileId: "file_image_1" },
      { kind: "emoji", fileId: "file_emoji_1" }
    ],
    imageIds: ["file_image_1"],
    emojiIds: ["file_emoji_1"],
    timestampMs: 1710000000000
  });

  assert.equal(item.kind, "user_media_message");
  if (item.kind !== "user_media_message") {
    throw new Error("expected user media message");
  }
  assert.equal(item.mediaKind, "mixed");

  const projected = projectTranscriptMessageItemToHistoryMessage(item);
  assert.match(projected.content, /kind="image" image_id="file_image_1"/);
  assert.match(projected.content, /kind="emoji" image_id="file_emoji_1"/);
});

test("history projection preserves audio content part ids for later transcription context", () => {
  const item = createUserTranscriptMessageItem({
    chatType: "private",
    userId: "10001",
    senderName: "Alice",
    text: "",
    contentParts: [
      { kind: "audio", source: "voice.amr", audioId: "aud-1" }
    ],
    timestampMs: 1710000000000
  });

  const projected = projectTranscriptMessageItemToHistoryMessage(item);
  assert.match(projected.content, new RegExp(escapeRegExp(buildTag("audio", { audio_id: "aud-1" }))));
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
