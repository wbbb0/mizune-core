import test from "node:test";
import assert from "node:assert/strict";
import { imageToolHandlers } from "../../src/llm/tools/conversation/imageTools.ts";
import { messageToolHandlers } from "../../src/llm/tools/conversation/messageTools.ts";
import { createForwardFeatureConfig } from "../helpers/forward-test-support.tsx";
import { createFunctionToolCall, parseJsonToolResult } from "../helpers/tool-test-support.tsx";

  test("chat_file_view_media injects multimodal follow-up content for images", async () => {
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

  test("chat_file_view_media rejects requests above the hard limit", async () => {
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

  test("chat_file_inspect_media asks inspector for registered chat images", async () => {
    const result = await imageToolHandlers.chat_file_inspect_media!(
      createFunctionToolCall("chat_file_inspect_media", "tool_inspect_1"),
      { media_ids: ["file_test_1"], question: "读取表格金额列" },
      {
        chatFileStore: {
          async getMany() {
            return [{
              fileId: "file_test_1",
              fileRef: "chat_test0001.png",
              kind: "image",
              origin: "chat_message",
              chatFilePath: "workspace/media/file_test_1.png",
              sourceName: "table.png",
              mimeType: "image/png",
              sizeBytes: 1,
              createdAtMs: Date.now(),
              sourceContext: { mediaKind: "image" },
              caption: null
            }];
          }
        } as any,
        mediaVisionService: {
          async prepareFileForModel(fileId: string) {
            assert.equal(fileId, "file_test_1");
            return {
              fileId: "file_test_1",
              inputUrl: "data:image/png;base64,file_test_1",
              kind: "image",
              transport: "data_url",
              animated: false,
              durationMs: null,
              sampledFrameCount: null
            };
          }
        } as any,
        mediaInspectionService: {
          async inspectPreparedMedia(input: any) {
            assert.equal(input.question, "读取表格金额列");
            assert.deepEqual(input.media, [{
              mediaId: "file_test_1",
              inputUrl: "data:image/png;base64,file_test_1",
              kind: "image",
              animated: false,
              durationMs: null,
              sampledFrameCount: null
            }]);
            return {
              ok: true,
              requestedCount: 1,
              results: [{
                mediaId: "file_test_1",
                status: "answered",
                found: true,
                answer: "金额列最大值是 9800。",
                visibleContentSummary: "一张表格截图。",
                nearMatches: [],
                confidenceNotes: [],
                rawAnswer: "{}",
                parseStatus: "parsed",
                schemaIssues: [],
                modelRef: "vision"
              }]
            };
          }
        } as any
      } as any
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.requested_count, 1);
    assert.equal(parsed.inspected_count, 1);
    assert.equal(parsed.results[0].media_id, "file_test_1");
    assert.equal(parsed.results[0].answer, "金额列最大值是 9800。");
    assert.equal(parsed.results[0].visible_content_summary, "一张表格截图。");
    assert.equal(parsed.workspace, undefined);
    assert.equal(parsed.results[0].rawAnswer, undefined);
    assert.equal(parsed.results[0].parseStatus, undefined);
    assert.equal(parsed.results[0].modelRef, undefined);
  });

  test("local_file_inspect_media asks inspector for a resolved local image path", async () => {
    const result = await imageToolHandlers.local_file_inspect_media!(
      createFunctionToolCall("local_file_inspect_media", "tool_inspect_2"),
      { path: "screens/table.png", question: "读取 A1 单元格" },
      {
        localFileService: {
          resolvePath(path: string) {
            assert.equal(path, "screens/table.png");
            return {
              absolutePath: "/tmp/screens/table.png",
              relativePath: "screens/table.png"
            };
          }
        } as any,
        mediaVisionService: {
          async prepareAbsolutePathForModel(absolutePath: string, sourceName: string) {
            assert.equal(absolutePath, "/tmp/screens/table.png");
            assert.equal(sourceName, "table.png");
            return {
              fileId: "/tmp/screens/table.png",
              inputUrl: "data:image/png;base64,local",
              kind: "image",
              transport: "data_url",
              animated: false,
              durationMs: null,
              sampledFrameCount: null
            };
          }
        } as any,
        mediaInspectionService: {
          async inspectPreparedMedia(input: any) {
            assert.equal(input.question, "读取 A1 单元格");
            assert.equal(input.media[0].mediaId, "table.png");
            assert.equal(input.media[0].inputUrl, "data:image/png;base64,local");
            return {
              ok: true,
              requestedCount: 1,
              results: [{
                mediaId: "table.png",
                status: "answered",
                found: true,
                answer: "A1 是 日期。",
                visibleContentSummary: null,
                nearMatches: [],
                confidenceNotes: [],
                rawAnswer: "{}",
                parseStatus: "parsed",
                schemaIssues: [],
                modelRef: "vision"
              }]
            };
          }
        } as any
      } as any
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.path, "screens/table.png");
    assert.equal(parsed.source_name, "table.png");
    assert.equal(parsed.results[0].answer, "A1 是 日期。");
  });

  test("chat_file_inspect_media rejects unsupported media ids", async () => {
    const result = await imageToolHandlers.chat_file_inspect_media!(
      createFunctionToolCall("chat_file_inspect_media", "tool_inspect_3"),
      { media_ids: ["legacy-image"], question: "看图" },
      {
        chatFileStore: { async getMany() { return []; } } as any,
        mediaVisionService: { async prepareFileForModel() { throw new Error("should not be called"); } } as any,
        mediaInspectionService: { async inspectPreparedMedia() { throw new Error("should not be called"); } } as any
      } as any
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.match(parsed.error, /Unsupported legacy media ids/);
  });

  test("view_message normalizes reply, mentions, forward ids, and images", async () => {
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
