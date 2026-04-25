import test from "node:test";
import assert from "node:assert/strict";
import { webToolHandlers } from "../../src/llm/tools/web/webTools.ts";
import type { BrowserElement } from "../../src/services/web/browser/types.ts";
import {
  createBrowserCloseResult,
  createBrowserInspectResult,
  createBrowserInteractResult,
  createBrowserOpenResult,
  createBrowserToolContext
} from "../helpers/browser-fixtures.tsx";

import { createFunctionToolCall, parseJsonToolResult } from "../helpers/tool-test-support.tsx";

const aboutLinkElement: BrowserElement = {
  id: 1,
  kind: "link",
  label: "链接: About",
  why_selected: ["主内容"],
  role: "link",
  name: "About",
  tag: "a",
  text: "About",
  type: null,
  action: "click",
  disabled: false,
  href: "https://openai.com/about",
  placeholder: null,
  value_preview: null,
  checked: null,
  selected: null,
  expanded: null,
  visibility: "visible",
  locator_hint: "a[href*=\"/about\"]",
  has_image: false,
  in_main_content: true,
  media_url: null,
  poster_url: null,
  source_urls: []
};

  test("open_page accepts direct urls", async () => {
    const result = await webToolHandlers.open_page!(
      createFunctionToolCall("open_page", "tool_5"),
      { url: "https://vertexaisearch.cloud.google.com/redirect/1", description: "继续登录后台" },
      createBrowserToolContext({
        async openPage({ url, description }) {
          assert.equal(description, "继续登录后台");
          return createBrowserOpenResult({
            requestedUrl: String(url),
            resolvedUrl: "https://openai.com",
            links: [{ id: 1, text: "About", url: "https://openai.com/about", host: "openai.com" }],
            elements: [aboutLinkElement]
          });
        }
      })
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.resource_id, "res_browser_1");
    assert.equal(parsed.resolvedUrl, "https://openai.com");
    assert.deepEqual(
      parsed.next_actions.map((item: { tool: string }) => item.tool),
      ["inspect_page", "interact_with_page", "capture_screenshot", "download_asset"]
    );
  });

  test("open_page accepts ref ids", async () => {
    const result = await webToolHandlers.open_page!(
      createFunctionToolCall("open_page", "tool_6"),
      { ref_id: "search_1", line: 12 },
      createBrowserToolContext({
        async openPage({ refId, line }) {
          assert.equal(refId, "search_1");
          assert.equal(line, 12);
          return createBrowserOpenResult({
            resource_id: "res_browser_2",
            lines: ["L2 About OpenAI"],
            lineStart: 2,
            lineEnd: 2
          });
        }
      })
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.resource_id, "res_browser_2");
  });

  test("inspect_page returns matching lines", async () => {
    const result = await webToolHandlers.inspect_page!(
      createFunctionToolCall("inspect_page", "tool_7"),
      { resource_id: "res_browser_2", pattern: "OpenAI" },
      createBrowserToolContext({
        async inspectPage({ resourceId, pattern }) {
          assert.equal(resourceId, "res_browser_2");
          assert.equal(pattern, "OpenAI");
          return createBrowserInspectResult({
            resource_id: resourceId,
            pattern,
            matches: [{ lineNumber: 2, text: "L2 About OpenAI" }]
          });
        }
      })
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.matches[0].lineNumber, 2);
    assert.deepEqual(
      parsed.next_actions.map((item: { tool: string }) => item.tool),
      ["interact_with_page", "capture_screenshot", "download_asset"]
    );
  });

  test("interact_with_page forwards page actions", async () => {
    const result = await webToolHandlers.interact_with_page!(
      createFunctionToolCall("interact_with_page", "tool_8"),
      { resource_id: "res_browser_1", action: "click", target_id: 1, line: 20 },
      createBrowserToolContext({
        async interactWithPage({ resourceId, action, targetId, line }) {
          assert.equal(resourceId, "res_browser_1");
          assert.equal(action, "click");
          assert.equal(targetId, 1);
          assert.equal(line, 20);
          return createBrowserInteractResult({
            resolved_target: aboutLinkElement,
            candidate_count: 1,
            message: "已命中元素 #1（About）。",
            snapshot: createBrowserInspectResult({
              resource_id: "res_browser_1",
              requestedUrl: "https://openai.com/about",
              resolvedUrl: "https://openai.com/about",
              title: "About",
              lines: ["L11 About page"],
              lineStart: 11,
              lineEnd: 11
            })
          });
        }
      })
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.snapshot.resource_id, "res_browser_1");
    assert.equal(parsed.snapshot.title, "About");
    assert.equal(parsed.resolved_target.id, 1);
  });

  test("interact_with_page rejects unsupported actions before calling browser service", async () => {
    let called = false;
    const result = await webToolHandlers.interact_with_page!(
      createFunctionToolCall("interact_with_page", "tool_8b"),
      { resource_id: "res_browser_1", action: "dance" },
      createBrowserToolContext({
        async interactWithPage() {
          called = true;
          throw new Error("should not be called");
        }
      })
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.error, "unsupported action: dance");
    assert.equal(called, false);
  });

  test("interact_with_page forwards semantic targets", async () => {
    const result = await webToolHandlers.interact_with_page!(
      createFunctionToolCall("interact_with_page", "tool_8c"),
      {
        resource_id: "res_browser_1",
        action: "type",
        target: {
          role: "textbox",
          name: "搜索",
          index: 1
        },
        text: "OpenAI"
      },
      createBrowserToolContext({
        async interactWithPage({ action, target, text }) {
          assert.equal(action, "type");
          assert.deepEqual(target, { role: "textbox", name: "搜索", index: 1 });
          assert.equal(text, "OpenAI");
          return createBrowserInteractResult({
            action: "type",
            candidate_count: 1,
            message: "已对元素 搜索 执行 type。"
          });
        }
      })
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, "type");
    assert.equal(parsed.candidate_count, 1);
  });

  test("interact_with_page keeps text input whitespace", async () => {
    const result = await webToolHandlers.interact_with_page!(
      createFunctionToolCall("interact_with_page", "tool_8c2"),
      {
        resource_id: "res_browser_1",
        action: "type",
        target_id: 1,
        text: "  OpenAI\nLabs  "
      },
      createBrowserToolContext({
        async interactWithPage({ text }) {
          assert.equal(text, "  OpenAI\nLabs  ");
          return createBrowserInteractResult({
            action: "type",
            candidate_count: 1
          });
        }
      })
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
  });

  test("interact_with_page resolves workspace uploads", async () => {
    const result = await webToolHandlers.interact_with_page!(
      createFunctionToolCall("interact_with_page", "tool_8d"),
      {
        resource_id: "res_browser_1",
        action: "upload",
        target_id: 3,
        file_paths: ["uploads/demo file.txt"]
      },
      createBrowserToolContext({
        async interactWithPage({ action, targetId, filePaths }) {
          assert.equal(action, "upload");
          assert.equal(targetId, 3);
          assert.deepEqual(filePaths, ["/tmp/workspace/uploads/demo file.txt"]);
          return createBrowserInteractResult({
            action: "upload",
            candidate_count: 1,
            message: "已上传 1 个文件。"
          });
        }
      })
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, "upload");
  });

  test("interact_with_page forwards coordinate clicks", async () => {
    const result = await webToolHandlers.interact_with_page!(
      createFunctionToolCall("interact_with_page", "tool_8e"),
      {
        resource_id: "res_browser_1",
        action: "click",
        coordinate: { x: 320, y: 240 }
      },
      createBrowserToolContext({
        async interactWithPage({ action, coordinate }) {
          assert.equal(action, "click");
          assert.deepEqual(coordinate, { x: 320, y: 240 });
          return createBrowserInteractResult({
            action: "click",
            message: "已在坐标 (320, 240) 执行 click。"
          });
        }
      })
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.message, "已在坐标 (320, 240) 执行 click。");
  });

  test("close_page closes opened sessions", async () => {
    const result = await webToolHandlers.close_page!(
      createFunctionToolCall("close_page", "tool_9"),
      { resource_id: "res_browser_1" },
      createBrowserToolContext({
        async closePage(resourceId: string) {
          assert.equal(resourceId, "res_browser_1");
          return createBrowserCloseResult({ resource_id: resourceId });
        }
      })
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.closed, true);
  });

  test("capture_screenshot attaches page screenshot context", async () => {
    const result = await webToolHandlers.capture_screenshot!(
      createFunctionToolCall("capture_screenshot", "tool_10"),
      { resource_id: "res_browser_1" },
      createBrowserToolContext({
        async capturePageScreenshot() {
          return {
            ok: true,
            resource_id: "res_browser_1",
            profile_id: "browser_profile_1",
            fileId: "img_1",
            mimeType: "image/png",
            sizeBytes: 123,
            mode: "page",
            target_id: null
          };
        }
      })
    );

    if (typeof result === "string") {
      throw new Error("expected structured screenshot result");
    }
    assert.match(String(result.content), /"file_id":"img_1"/);
    assert.equal(result.supplementalMessages?.length, 1);
  });

  test("capture_screenshot supports element-level screenshot", async () => {
    const result = await webToolHandlers.capture_screenshot!(
      createFunctionToolCall("capture_screenshot", "tool_10a"),
      { resource_id: "res_browser_1", target_id: 3 },
      createBrowserToolContext({
        async captureElementScreenshot(resourceId, targetId) {
          assert.equal(resourceId, "res_browser_1");
          assert.equal(targetId, 3);
          return {
            ok: true,
            resource_id: "res_browser_1",
            profile_id: "browser_profile_1",
            fileId: "img_2",
            mimeType: "image/png",
            sizeBytes: 321,
            mode: "element",
            target_id: 3
          };
        }
      })
    );
    if (typeof result === "string") {
      throw new Error("expected structured screenshot result");
    }
    assert.match(String(result.content), /"file_id":"img_2"/);
    assert.equal(result.supplementalMessages?.length, 1);
  });

  test("download_asset supports direct urls", async () => {
    const result = await webToolHandlers.download_asset!(
      createFunctionToolCall("download_asset", "tool_10b"),
      { url: "https://example.com/video.mp4", source_name: "video.mp4", kind: "video" },
      createBrowserToolContext({
        async downloadAsset(input) {
          assert.equal(input.url, "https://example.com/video.mp4");
          assert.equal(input.sourceName, "video.mp4");
          assert.equal(input.kind, "video");
          return {
            ok: true,
            file_id: "file_1",
            kind: "video",
            source_name: "video.mp4",
            mimeType: "video/mp4",
            sizeBytes: 123,
            origin: "browser_download",
            source_url: "https://example.com/video.mp4",
            resource_id: null,
            target_id: null
          };
        }
      })
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.file_id, "file_1");
  });

  test("download_asset supports browser resource targets", async () => {
    const result = await webToolHandlers.download_asset!(
      createFunctionToolCall("download_asset", "tool_10c"),
      { resource_id: "res_browser_1", target_id: 2 },
      createBrowserToolContext({
        async downloadAsset(input) {
          assert.equal(input.resourceId, "res_browser_1");
          assert.equal(input.targetId, 2);
          return {
            ok: true,
            file_id: "file_2",
            kind: "image",
            source_name: "cover.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 456,
            origin: "browser_download",
            source_url: "https://example.com/cover.jpg",
            resource_id: "res_browser_1",
            target_id: 2
          };
        }
      })
    );

    const parsed = parseJsonToolResult<any>(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.resource_id, "res_browser_1");
    assert.equal(parsed.target_id, 2);
    assert.equal(parsed.file_id, "file_2");
    assert.deepEqual(
      parsed.next_actions.map((item: { tool: string }) => item.tool),
      ["chat_file_view_media", "chat_file_send_to_chat"]
    );
  });
