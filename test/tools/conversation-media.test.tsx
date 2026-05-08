import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageToolHandlers } from "../../src/llm/tools/conversation/imageTools.ts";
import { messageToolHandlers } from "../../src/llm/tools/conversation/messageTools.ts";
import { createForwardFeatureConfig } from "../helpers/forward-test-support.tsx";
import { createFunctionToolCall, parseJsonToolResult } from "../helpers/tool-test-support.tsx";

  test("asset_media_view injects multimodal follow-up content for images", async () => {
    const result = await imageToolHandlers.asset_media_view!(
      createFunctionToolCall("asset_media_view", "tool_1"),
      { asset_ids: ["file_test_1"] },
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
    const payload = JSON.parse(result.content);
    assert.equal(payload.asset_handles[0].source, "asset");
    assert.equal(payload.asset_handles[0].asset_id, "file_test_1");
    assert.equal(payload.asset_handles[0].asset_ref, "chat_test0001.gif");
    assert.equal(payload.handles[0].source, "asset");
    assert.equal(payload.handles[0].selector.file_ref, "chat_test0001.gif");
    assert.deepEqual(
      payload.handles[0].capabilities.map((item: { capability: string }) => item.capability),
      ["view_media", "inspect_media", "send_to_chat"]
    );
  });

  test("asset_media_view resolves asset_ref and exposes asset handle selectors", async () => {
    const result = await imageToolHandlers.asset_media_view!(
      createFunctionToolCall("asset_media_view", "tool_asset_media_view_1"),
      { asset_ref: "chat_test0001.png" },
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
          async listFiles() {
            return [{
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
            }];
          },
          async getMany(fileIds: string[]) {
            assert.deepEqual(fileIds, ["file_test_1"]);
            return [{
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
            }];
          }
        } as any,
        mediaVisionService: {
          async prepareFileForModel() {
            return {
              fileId: "file_test_1",
              inputUrl: "https://example.com/a.png",
              kind: "image",
              transport: "data_url",
              animated: false,
              durationMs: null,
              sampledFrameCount: null
            };
          }
        } as any,
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
    const payload = JSON.parse(result.content);
    assert.equal(payload.asset_handles[0].asset_ref, "chat_test0001.png");
    assert.deepEqual(
      payload.asset_handles[0].capabilities.map((item: { tool: string; args: Record<string, unknown> }) => [item.tool, item.args]),
      [
        ["asset_media_view", { asset_ref: "chat_test0001.png" }],
        ["asset_media_inspect", { asset_ref: "chat_test0001.png" }],
        ["asset_send_to_chat", { asset_ref: "chat_test0001.png" }]
      ]
    );
  });

  test("asset_media_view rejects requests above the hard limit", async () => {
    const result = await imageToolHandlers.asset_media_view!(
      createFunctionToolCall("asset_media_view", "tool_2"),
      { asset_ids: ["1", "2", "3", "4", "5", "6"] },
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

  test("asset_media_view next actions honor visible tool names", async () => {
    const result = await imageToolHandlers.asset_media_view!(
      createFunctionToolCall("asset_media_view", "tool_visible_actions_1"),
      { asset_ids: ["file_test_1"] },
      {
        debugSnapshot: {
          visibleToolNames: ["asset_media_view"]
        },
        audioStore: {
          async getMany() {
            return [];
          }
        } as any,
        chatFileStore: {
          async getMany() {
            return [{
              fileId: "file_test_1",
              fileRef: "chat_test0001.png",
              kind: "image",
              origin: "browser_download",
              chatFilePath: "workspace/media/file_test_1.png",
              sourceName: "a.png",
              mimeType: "image/png",
              sizeBytes: 1,
              createdAtMs: Date.now(),
              sourceContext: {},
              caption: null
            }];
          }
        } as any,
        mediaVisionService: {
          async prepareFileForModel() {
            return {
              fileId: "file_test_1",
              inputUrl: "https://example.com/a.png",
              kind: "image",
              transport: "data_url",
              animated: false,
              durationMs: null,
              sampledFrameCount: null
            };
          }
        } as any
      } as any
    );
    if (typeof result === "string") {
      throw new Error("expected structured multimodal result");
    }
    const payload = JSON.parse(result.content);
    assert.deepEqual(payload.next_actions, []);
    assert.deepEqual(
      payload.handles[0].capabilities.map((item: { capability: string; available: boolean }) => [item.capability, item.available]),
      [["view_media", true], ["inspect_media", false], ["send_to_chat", false]]
    );
  });

  test("asset_media_inspect asks inspector for registered chat images", async () => {
    const result = await imageToolHandlers.asset_media_inspect!(
      createFunctionToolCall("asset_media_inspect", "tool_inspect_1"),
      { asset_ids: ["file_test_1"], question: "读取表格金额列" },
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

  test("filesystem_media_inspect asks inspector for a resolved local image path", async () => {
    const result = await imageToolHandlers.filesystem_media_inspect!(
      createFunctionToolCall("filesystem_media_inspect", "tool_inspect_2"),
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

  test("filesystem_media_view returns a local file handle for follow-up tools", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-local-media-"));
    const filePath = join(tempDir, "screen.png");
    await writeFile(filePath, Buffer.from("fake image bytes"));
    try {
      const result = await imageToolHandlers.filesystem_media_view!(
        createFunctionToolCall("filesystem_media_view", "tool_local_view_1"),
        { path: filePath },
        {
          debugSnapshot: {
            visibleToolNames: ["filesystem_media_view", "filesystem_media_inspect", "filesystem_send_to_chat"]
          },
          localFileService: {
            resolvePath(path: string) {
              return { relativePath: path, absolutePath: path };
            }
          } as any,
          mediaVisionService: {
            async prepareAbsolutePathForModel(absolutePath: string, sourceName: string) {
              assert.equal(absolutePath, filePath);
              assert.equal(sourceName, "screen.png");
              return {
                fileId: filePath,
                inputUrl: "data:image/png;base64,local",
                kind: "image",
                transport: "data_url",
                animated: false,
                durationMs: null,
                sampledFrameCount: null
              };
            }
          } as any
        } as any
      );
      if (typeof result === "string") {
        throw new Error("expected structured multimodal result");
      }
      const payload = JSON.parse(result.content);
      assert.equal(payload.handle.source, "filesystem");
      assert.equal(payload.handle.selector.path, filePath);
      assert.equal("asset_handle" in payload, false);
      assert.deepEqual(
        payload.handle_capabilities.map((item: { capability: string }) => item.capability),
        ["read_text", "view_media", "inspect_media", "send_to_chat"]
      );
      assert.deepEqual(
        payload.next_actions.map((item: { tool: string }) => item.tool),
        ["filesystem_send_to_chat"]
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("filesystem_media_view omits send next action when send tool is hidden", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "llm-onebot-local-media-hidden-"));
    const filePath = join(tempDir, "screen.png");
    await writeFile(filePath, Buffer.from("fake image bytes"));
    try {
      const result = await imageToolHandlers.filesystem_media_view!(
        createFunctionToolCall("filesystem_media_view", "tool_local_view_hidden"),
        { path: filePath },
        {
          debugSnapshot: {
            visibleToolNames: ["filesystem_media_view"]
          },
          localFileService: {
            resolvePath(path: string) {
              return { relativePath: path, absolutePath: path };
            }
          } as any,
          mediaVisionService: {
            async prepareAbsolutePathForModel() {
              return {
                fileId: filePath,
                inputUrl: "data:image/png;base64,local",
                kind: "image",
                transport: "data_url",
                animated: false,
                durationMs: null,
                sampledFrameCount: null
              };
            }
          } as any
        } as any
      );
      if (typeof result === "string") {
        throw new Error("expected structured multimodal result");
      }
      const payload = JSON.parse(result.content);
      assert.deepEqual(payload.next_actions, []);
      assert.deepEqual(
        payload.handle_capabilities.map((item: { capability: string; available: boolean }) => [item.capability, item.available]),
        [["read_text", false], ["view_media", true], ["inspect_media", false], ["send_to_chat", false]]
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("asset_media_inspect rejects unsupported media ids", async () => {
    const result = await imageToolHandlers.asset_media_inspect!(
      createFunctionToolCall("asset_media_inspect", "tool_inspect_3"),
      { asset_ids: ["legacy-image"], question: "看图" },
      {
        chatFileStore: { async getMany() { return []; } } as any,
        mediaVisionService: { async prepareFileForModel() { throw new Error("should not be called"); } } as any,
        mediaInspectionService: { async inspectPreparedMedia() { throw new Error("should not be called"); } } as any
      } as any
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.match(parsed.error, /unknown or unsupported media asset/);
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

  test("view_message exposes file ids without downloading message files", async () => {
    const result = await messageToolHandlers.view_message!(
      createFunctionToolCall("view_message", "tool_file_view"),
      { message_id: "556" },
      {
        oneBotClient: {
          async getMessage() {
            return {
              message_id: 556,
              message_type: "private",
              user_id: 10001,
              sender: { nickname: "Tester" },
              time: 1710000000,
              message: [{
                type: "file",
                data: {
                  file: "report.pdf",
                  file_id: "onebot-file-1",
                  file_size: 1234
                }
              }]
            };
          }
        } as any,
        chatFileStore: {
          async importRemoteSource() {
            throw new Error("view_message should not download message files");
          }
        } as any
      } as any
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.attachments, []);
    assert.equal(parsed.files[0].fileId, "onebot-file-1");
    assert.equal(parsed.files[0].filename, "report.pdf");
    assert.match(parsed.segments[0].summary, /download_message_file/);
  });

  test("download_message_file resolves OneBot file_id and returns an asset handle", async () => {
    const result = await messageToolHandlers.download_message_file!(
      createFunctionToolCall("download_message_file", "tool_file_download"),
      { file_id: "onebot-file-1", source_name: "report.pdf" },
      {
        lastMessage: {
          sessionId: "qqbot:p:10001",
          userId: "u1",
          senderName: "Tester"
        },
        oneBotClient: {
          async getFile(fileId: string) {
            assert.equal(fileId, "onebot-file-1");
            return {
              file: "/tmp/report.pdf",
              url: "/tmp/report.pdf",
              fileName: "report.pdf",
              fileSize: 1234
            };
          }
        } as any,
        chatFileStore: {
          async importRemoteSource(input: any) {
            assert.equal(input.source, "/tmp/report.pdf");
            assert.equal(input.sourceName, "report.pdf");
            assert.equal(input.sourceContext.onebot_file_id, "onebot-file-1");
            return {
              fileId: "file_saved_1",
              fileRef: "chat_saved.pdf",
              kind: "file",
              origin: "chat_message",
              chatFilePath: "chat-files/media/chat_saved.pdf",
              sourceName: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 1234,
              createdAtMs: 1,
              sourceContext: input.sourceContext,
              caption: null,
              captionStatus: "missing"
            };
          }
        } as any,
        debugSnapshot: {
          visibleToolNames: ["asset_document_overview", "asset_document_read", "asset_send_to_chat"]
        }
      } as any
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.asset_id, "file_saved_1");
    assert.equal(parsed.asset_handle.asset_ref, "chat_saved.pdf");
    assert.equal(parsed.onebot_file_id, "onebot-file-1");
  });
