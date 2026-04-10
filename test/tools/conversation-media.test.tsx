import assert from "node:assert/strict";
import { imageToolHandlers } from "../../src/llm/tools/conversation/imageTools.ts";
import { messageToolHandlers } from "../../src/llm/tools/conversation/messageTools.ts";
import { createForwardFeatureConfig, runCase } from "../helpers/forward-test-support.tsx";
import { createFunctionToolCall, parseJsonToolResult } from "../helpers/tool-test-support.tsx";

async function main() {
  await runCase("chat_file_view_media injects multimodal follow-up content for images", async () => {
    const result = await imageToolHandlers.chat_file_view_media!(
      createFunctionToolCall("chat_file_view_media", "tool_1"),
      { media_ids: ["file_test_1"] },
      {
        config: createForwardFeatureConfig(),
        audioStore: {
          async getTranscriptionMap() {
            return new Map();
          },
          async getMany() {
            return [];
          }
        } as any,
        chatFileStore: {
          async getMany() {
            return [{
              fileId: "file_test_1",
              fileRef: "chat_test0001.gif",
              kind: "animated_image",
              origin: "chat_message",
              chatFilePath: "workspace/media/file_test_1.gif",
              sourceName: "a.gif",
              mimeType: "image/gif",
              sizeBytes: 1,
              createdAtMs: Date.now(),
              sourceContext: { mediaKind: "emoji" },
              caption: null
            }];
          }
        } as any,
        mediaVisionService: {
          async prepareFileForModel() {
            return {
              fileId: "file_test_1",
              inputUrl: "https://example.com/a.png",
              kind: "animated_image",
              transport: "data_url",
              animated: true,
              durationMs: 2400,
              sampledFrameCount: 4
            };
          }
        } as any
        ,
        mediaCaptionService: {
          async getCaptionMap() {
            return new Map();
          }
        } as any
      } as any
    );

    if (typeof result === "string") {
      throw new Error("expected structured multimodal result");
    }
    assert.ok(result.supplementalMessages);
    const [message] = result.supplementalMessages;
    assert.ok(message);
    assert.equal(result.supplementalMessages.length, 1);
    assert.equal(message.role, "user");
    assert.ok(Array.isArray(message.content));
    const contentPart = message.content[1];
    assert.ok(contentPart && typeof contentPart !== "string");
    assert.equal(contentPart.type, "image_url");
    assert.match(result.content, /"durationMs":2400/);
  });

  await runCase("chat_file_view_media rejects requests above the hard limit", async () => {
    const result = await imageToolHandlers.chat_file_view_media!(
      createFunctionToolCall("chat_file_view_media", "tool_2"),
      { media_ids: ["1", "2", "3", "4", "5", "6"] },
      {
        audioStore: { async getTranscriptionMap() { return new Map(); }, async getMany() { return []; } } as any,
        chatFileStore: { async getMany() { return []; } } as any,
        mediaVisionService: { async prepareFileForModel() { throw new Error("should not be called"); } } as any,
        mediaCaptionService: { async getCaptionMap() { return new Map(); } } as any
      } as any
    );

    assert.equal(typeof result, "string");
    if (typeof result !== "string") {
      throw new Error("expected string tool error");
    }
    assert.match(result, /at most 5/);
  });

  await runCase("view_message normalizes reply, mentions, forward ids, and images", async () => {
    const result = await messageToolHandlers.view_message!(
      createFunctionToolCall("view_message", "tool_3"),
      { message_id: "555" },
      {
        oneBotClient: {
          async getMessage() {
            return {
              message_id: 555,
              message_type: "group",
              user_id: 10001,
              group_id: 20001,
              sender: { nickname: "Tester" },
              time: 1710000000,
              message: [
                { type: "reply", data: { id: "444" } },
                { type: "at", data: { qq: "30003" } },
                { type: "text", data: { text: "你好" } },
                { type: "forward", data: { id: "forward-xyz" } },
                { type: "image", data: { url: "https://example.com/a.png" } }
              ]
            };
          }
        } as any,
        chatFileStore: {
          async importRemoteSource() {
            return {
              fileId: "file_test_1",
              fileRef: "chat_test0001.png",
              kind: "image",
              origin: "chat_message",
              chatFilePath: "workspace/media/file_test_1.png",
              sourceName: "a.png",
              mimeType: "image/png",
              sizeBytes: 1,
              createdAtMs: Date.now(),
              sourceContext: {},
              caption: null
            };
          }
        } as any
      } as any
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.replyMessageId, "444");
    assert.deepEqual(parsed.mentions.userIds, ["30003"]);
    assert.deepEqual(parsed.forwardIds, ["forward-xyz"]);
    assert.equal(parsed.segments[0].kind, "reply");
    assert.equal(parsed.segments[1].kind, "mention");
    assert.equal(parsed.segments[3].kind, "forward");
    assert.equal(parsed.segments[4].kind, "image");
    assert.equal(parsed.segments[4].fileId, "file_test_1");
    assert.equal(parsed.segments[4].mediaKind, "image");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
