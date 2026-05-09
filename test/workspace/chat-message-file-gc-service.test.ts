import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { ChatMessageFileGcService } from "../../src/services/workspace/chatMessageFileGcService.ts";

test("chat message file gc keeps files referenced by user media content parts", async () => {
  const deletedFileIds: string[] = [];
  const service = new ChatMessageFileGcService({
    async listFiles() {
      return [
        { fileId: "keep-media", origin: "chat_message", createdAtMs: 0 },
        { fileId: "keep-asset", origin: "chat_message", createdAtMs: 0 },
        { fileId: "delete-me", origin: "chat_message", createdAtMs: 0 }
      ] as any;
    },
    async deleteFile(fileId: string) {
      deletedFileIds.push(fileId);
      return true;
    }
  }, pino({ level: "silent" }), 1);

  const result = await service.sweep({
    now: 100,
    activeSessions: [{
      pendingMessages: [],
      internalTranscript: [{
        kind: "user_media_message",
        role: "user",
        llmVisible: true,
        chatType: "private",
        userId: "10001",
        senderName: "Alice",
        mediaKind: "mixed",
        contentParts: [
          { kind: "image", fileId: "keep-media" },
          { kind: "asset_file", fileId: "keep-asset", fileKind: "file", sourceName: "note.txt", mimeType: "text/plain", sizeBytes: 12 }
        ],
        imageIds: [],
        emojiIds: [],
        attachments: [],
        replyMessageId: null,
        mentionUserIds: [],
        mentionedAll: false,
        mentionedSelf: false,
        timestampMs: 1
      }]
    } as any],
    persistedSessions: []
  });

  assert.deepEqual(result.deletedFileIds, ["delete-me"]);
  assert.deepEqual(deletedFileIds, ["delete-me"]);
});
