import test from "node:test";
import assert from "node:assert/strict";
import { EventRouter } from "../../src/services/onebot/eventRouter.ts";
import { buildUserBatchContent } from "../../src/llm/prompts/trigger-batch.prompt.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("event router keeps dice-only messages as special segments", () => {
  const config = createTestAppConfig();
  const router = new EventRouter(config, config.configRuntime.instanceName);
  const parsed = router.toIncomingMessage({
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 1,
    user_id: 10001,
    message: [{ type: "dice", data: { result: 4 } }],
    raw_message: "[CQ:dice,result=4]",
    sender: { user_id: 10001, nickname: "Tester" },
    self_id: 20002,
    time: Math.floor(Date.now() / 1000)
  });

  assert.equal(parsed?.text, "");
  assert.deepEqual(parsed?.specialSegments, [{ type: "dice", summary: "骰子：4" }]);
});

test("event router keeps rich-card and location messages as special segments", () => {
  const config = createTestAppConfig();
  const router = new EventRouter(config, config.configRuntime.instanceName);
  const parsed = router.toIncomingMessage({
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 2,
    user_id: 10001,
    group_id: 30001,
    message: [
      { type: "json", data: { data: JSON.stringify({ title: "公告卡片", summary: "今晚维护", url: "https://example.com" }) } },
      { type: "location", data: { title: "集合点", address: "东门", lat: 31.2, lon: 121.5 } },
      { type: "at", data: { qq: "20002" } }
    ],
    raw_message: "[CQ:json,...][CQ:location,...][CQ:at,qq=20002]",
    sender: { user_id: 10001, nickname: "Tester" },
    self_id: 20002,
    time: Math.floor(Date.now() / 1000)
  });

  assert.equal(parsed?.isAtMentioned, true);
  assert.equal(parsed?.specialSegments?.length, 2);
  assert.match(parsed?.specialSegments?.[0]?.summary ?? "", /公告卡片/);
  assert.match(parsed?.specialSegments?.[1]?.summary ?? "", /集合点/);
});

test("prompt formatting includes special segment summaries outside raw text", () => {
  const content = buildUserBatchContent([{
    userId: "10001",
    senderName: "Tester",
    text: "",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    specialSegments: [{ type: "rps", summary: "猜拳：石头" }],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    mentionedSelf: false,
    timestampMs: Date.now()
  }]);

  const text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /segment type="rps"/);
  assert.match(text, /猜拳：石头/);
});
