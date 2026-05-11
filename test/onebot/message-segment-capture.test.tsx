import test from "node:test";
import assert from "node:assert/strict";
import { EventRouter } from "../../src/services/onebot/eventRouter.ts";
import { buildUserBatchContent } from "../../src/llm/prompts/trigger-batch.prompt.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { buildTag } from "../../src/utils/structuredEnvelope.ts";

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

test("event router exposes file messages as structured message files", () => {
  const config = createTestAppConfig();
  const router = new EventRouter(config, config.configRuntime.instanceName);
  const parsed = router.toIncomingMessage({
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 3,
    user_id: 10001,
    message: [{
      type: "file",
      data: {
        file: "铅毒之果.pdf",
        file_id: "onebot-file-1",
        file_size: 3673240
      }
    }],
    raw_message: "[CQ:file,file=铅毒之果.pdf]",
    sender: { user_id: 10001, nickname: "Tester" },
    self_id: 20002,
    time: Math.floor(Date.now() / 1000)
  });

  assert.equal(parsed?.text, "");
  assert.deepEqual(parsed?.specialSegments, []);
  assert.deepEqual(parsed?.messageFiles, [{
    fileId: "onebot-file-1",
    name: "铅毒之果.pdf",
    busid: null,
    sizeBytes: 3673240,
    mimeType: null,
    downloadTool: "download_message_file"
  }]);
});

test("event router preserves mixed text and media segment order as content parts", () => {
  const config = createTestAppConfig();
  const router = new EventRouter(config, config.configRuntime.instanceName);
  const parsed = router.toIncomingMessage({
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 4,
    user_id: 10001,
    message: [
      { type: "text", data: { text: "前" } },
      { type: "image", data: { url: "https://example.com/a.png" } },
      { type: "text", data: { text: "中" } },
      { type: "mface", data: { url: "https://example.com/e.gif" } },
      { type: "text", data: { text: "后" } }
    ],
    raw_message: "前[CQ:image]中[CQ:mface]后",
    sender: { user_id: 10001, nickname: "Tester" },
    self_id: 20002,
    time: Math.floor(Date.now() / 1000)
  });

  assert.deepEqual(parsed?.contentParts, [
    { kind: "text", text: "前" },
    { kind: "image", source: "https://example.com/a.png" },
    { kind: "text", text: "中" },
    { kind: "emoji", source: "https://example.com/e.gif" },
    { kind: "text", text: "后" }
  ]);
});

test("prompt formatting renders file messages as dedicated structured file tags", () => {
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
    messageFiles: [{
      fileId: "onebot-file-1",
      name: "report.pdf",
      busid: null,
      sizeBytes: 1234,
      mimeType: null,
      downloadTool: "download_message_file"
    }],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    mentionedSelf: false,
    timestampMs: Date.now()
  }]);

  const text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /%%llmbot:file /);
  assert.match(text, /file_id="onebot-file-1"/);
  assert.match(text, /download_tool="download_message_file"/);
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

test("prompt formatting preserves content part order", () => {
  const content = buildUserBatchContent([{
    userId: "10001",
    senderName: "Tester",
    text: "前中后",
    contentParts: [
      { kind: "text", text: "前" },
      { kind: "image", fileId: "img-1" },
      { kind: "text", text: "中" },
      { kind: "emoji", fileId: "emoji-1" },
      { kind: "text", text: "后" }
    ],
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: ["img-1"],
    emojiIds: ["emoji-1"],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    mentionedSelf: false,
    timestampMs: Date.now()
  }]);

  const text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, new RegExp(`前\\n${escapeRegExp(buildTag("ref", { kind: "image", image_id: "img-1" }))}\\n中\\n${escapeRegExp(buildTag("ref", { kind: "emoji", image_id: "emoji-1" }))}\\n后`));
});

test("prompt formatting renders landed web files as asset file tags", () => {
  const content = buildUserBatchContent([{
    userId: "10001",
    senderName: "Tester",
    text: "看附件",
    contentParts: [
      { kind: "text", text: "看附件" },
      { kind: "asset_file", fileId: "file-1", fileKind: "file", sourceName: "note.txt", mimeType: "text/plain", sizeBytes: 32 }
    ],
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    mentionedSelf: false,
    timestampMs: Date.now()
  }]);

  const text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /%%llmbot:asset_file /);
  assert.match(text, /file_id="file-1"/);
  assert.match(text, /file_kind="file"/);
  assert.doesNotMatch(text, /download_tool/);
});

test("prompt formatting keeps audio transcription next to audio content part", () => {
  const content = buildUserBatchContent([{
    userId: "10001",
    senderName: "Tester",
    text: "",
    contentParts: [
      { kind: "text", text: "听这个" },
      { kind: "audio", audioId: "aud-1", source: "voice.amr" }
    ],
    images: [],
    audioSources: ["voice.amr"],
    audioIds: ["aud-1"],
    audioTranscriptions: [{ audioId: "aud-1", status: "ready", text: "这是语音内容" }],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    mentionedSelf: false,
    timestampMs: Date.now()
  }]);

  const text = content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, new RegExp(`${escapeRegExp(buildTag("count", { kind: "audio", value: "1" }))}\\n音频 aud-1 听写：这是语音内容`));
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("prompt native multimodal inputs follow content part media order", () => {
  const content = buildUserBatchContent([{
    userId: "10001",
    senderName: "Tester",
    text: "",
    contentParts: [
      { kind: "audio", source: "voice.amr", audioId: "aud-1" },
      { kind: "image", fileId: "img-1" }
    ],
    images: [],
    audioSources: ["voice.amr"],
    audioIds: ["aud-1"],
    audioInputs: [{
      source: "voice.amr",
      mimeType: "audio/amr",
      format: "amr",
      data: "AAAA"
    }],
    emojiSources: [],
    imageIds: ["img-1"],
    imageVisuals: [{ imageId: "img-1", inputUrl: "data:image/png;base64,AAAA" }],
    emojiIds: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    mentionedSelf: false,
    timestampMs: Date.now()
  }]);

  const audioLabel = content.at(-4);
  const audioPart = content.at(-3);
  const imageLabel = content.at(-2);
  const imagePart = content.at(-1);
  assert.equal(audioLabel?.type, "text");
  assert.match(audioLabel?.type === "text" ? audioLabel.text : "", /Audio attached/);
  assert.equal(audioPart?.type, "input_audio");
  assert.equal(imageLabel?.type, "text");
  assert.match(imageLabel?.type === "text" ? imageLabel.text : "", /Image img-1 attached/);
  assert.equal(imagePart?.type, "image_url");
});
