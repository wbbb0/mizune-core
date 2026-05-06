import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { ContextIngestionService } from "../../src/context/contextIngestionService.ts";

test("ContextIngestionService writes raw messages, per-user episodes, and target-user recall chunks", () => {
  const rawMessages: Array<{ userId: string; role: string; text: string }> = [];
  const episodes: Array<{ itemId: string; userId: string; text: string; retrievalPolicy?: string }> = [];
  const chunks: Array<{ itemId: string; userId: string; text: string }> = [];
  const service = new ContextIngestionService({
    upsertRawMessages(messages) {
      rawMessages.push(...messages.map((message) => ({
        userId: message.userId,
        role: message.role,
        text: message.text
      })));
    },
    upsertConversationEpisode(input) {
      episodes.push({
        itemId: input.itemId,
        userId: input.userId,
        text: input.text,
        retrievalPolicy: "never"
      });
    },
    upsertUserSearchChunk(input) {
      chunks.push({
        itemId: input.itemId,
        userId: input.userId,
        text: input.text
      });
    }
  }, pino({ level: "silent" }));

  const result = service.ingestTurn({
    sessionId: "qqbot:g:100",
    chatType: "group",
    targetUserIds: ["u1", "u2", "u1"],
    userMessages: [
      { userId: "u1", senderName: "甲", text: "我喜欢 Orama 检索", receivedAt: 100 },
      { userId: "u2", senderName: "乙", text: "我在补测试", receivedAt: 110 }
    ],
    assistantText: "我会分别记下上下文。",
    completedAt: 200
  });

  assert.deepEqual(result, { rawMessageCount: 3, episodeCount: 2, chunkCount: 2 });
  assert.deepEqual(rawMessages.map((item) => `${item.role}:${item.userId}`), [
    "user:u1",
    "user:u2",
    "assistant:assistant"
  ]);
  assert.equal(episodes.length, 2);
  assert.ok(episodes.every((item) => item.text.includes("甲(u1)：我喜欢 Orama 检索")));
  assert.ok(episodes.every((item) => item.text.includes("乙(u2)：我在补测试")));
  assert.deepEqual(chunks.map((item) => item.userId), ["u1", "u2"]);
  assert.equal(chunks[0]?.text.includes("乙：我在补测试"), false);
  assert.equal(chunks[1]?.text.includes("甲：我喜欢 Orama 检索"), false);
});
