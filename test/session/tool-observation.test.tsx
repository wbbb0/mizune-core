import test from "node:test";
import assert from "node:assert/strict";
import { buildToolObservation } from "../../src/conversation/session/toolObservation.ts";
import { internalTranscriptItemSchema } from "../../src/conversation/session/transcriptContract.ts";
import { projectCompressionHistorySnapshot } from "../../src/conversation/session/sessionTranscript.ts";
import { buildHistorySummaryPrompt } from "../../src/llm/prompts/history-summary.prompt.ts";
import {
  audioTranscriptionToDerivedObservation,
  imageCaptionToDerivedObservation,
  toolObservationToDerivedObservation
} from "../../src/llm/derivations/derivedObservation.ts";
import {
  browserDownloadPolicy,
  browserPagePolicy,
  browserScreenshotPolicy,
  assetLocalPathPolicy,
  chatFileListPolicy,
  directMediaViewPolicy,
  debugDumpPolicy,
  fileSendPolicy,
  localFileListPolicy,
  localFileMutationPolicy,
  localFileSearchPolicy,
  terminalPolicy
} from "../../src/llm/tools/core/resultObservationPresets.ts";
import type { ToolResultObservationPolicy } from "../../src/llm/tools/core/resultObservation.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import type { InternalTranscriptItem } from "../../src/conversation/session/sessionTypes.ts";

test("filesystem_read observation keeps raw content out of replay and preserves a refetch handle", () => {
  const rawFileContent = Array.from({ length: 180 }, (_, index) => `RAW-LINE-${index + 1} const value${index} = ${index};`).join("\n");
  const rawToolContent = JSON.stringify({
    path: "src/app/generation/providerTranscriptProjector.ts",
    content: rawFileContent,
    startLine: 1,
    endLine: 180,
    totalLines: 500,
    truncated: true
  });

  const observation = buildToolObservation({
    toolName: "filesystem_read",
    toolCallId: "call_read_1",
    content: rawToolContent
  });

  assert.equal(observation.retention, "summary");
  assert.equal(observation.refetchable, true);
  assert.equal(observation.replaySafe, true);
  assert.equal(observation.resource?.kind, "filesystem");
  assert.equal(observation.resource?.id, "src/app/generation/providerTranscriptProjector.ts");
  assert.equal(observation.resource?.locator, "L1-L180");
  assert.ok(observation.contentHash.length >= 12);
  assert.ok(observation.summary.includes("src/app/generation/providerTranscriptProjector.ts"));
  assert.ok(observation.replayContent.length < rawToolContent.length / 2);
  assert.doesNotMatch(observation.replayContent, /RAW-LINE-120/);
  assert.match(observation.replayContent, /"compacted":true/);
  assert.match(observation.replayContent, /filesystem_read/);
  assert.match(observation.replayContent, /start_line=1 end_line=180/);
});

test("filesystem_list policy summarizes small and large directory listings", () => {
  const smallRaw = JSON.stringify({
    path: "src",
    items: [{ path: "src/index.ts", name: "index.ts", kind: "file", sizeBytes: 10 }]
  });
  const small = buildToolObservation({
    toolName: "filesystem_list",
    toolCallId: "call_ls_small",
    content: smallRaw,
    args: { path: "src" },
    policy: localFileListPolicy()
  });
  assert.equal(small.retention, "summary");
  assert.match(small.replayContent, /src\/index\.ts/);

  const statRaw = JSON.stringify({
    path: "src/index.ts",
    name: "index.ts",
    kind: "file",
    sizeBytes: 10,
    updatedAtMs: 123
  });
  const stat = buildToolObservation({
    toolName: "filesystem_list",
    toolCallId: "call_ls_file_stat",
    content: statRaw,
    args: { path: "src/index.ts" },
    policy: localFileListPolicy()
  });
  assert.equal(stat.retention, "summary");
  assert.match(stat.replayContent, /刷新文件元信息/);
  assert.doesNotMatch(stat.replayContent, /完整目录列表/);

  const largeRaw = JSON.stringify({
    path: "src",
    items: Array.from({ length: 45 }, (_, index) => ({
      name: index % 5 === 0 ? `dir-${index}` : `file-${index}.ts`,
      kind: index % 5 === 0 ? "directory" : "file"
    }))
  });
  const large = buildToolObservation({
    toolName: "filesystem_list",
    toolCallId: "call_ls_large",
    content: largeRaw,
    args: { path: "src" },
    policy: localFileListPolicy()
  });

  assert.equal(large.retention, "summary");
  assert.equal(large.resource?.kind, "filesystem");
  assert.equal(large.resource?.id, "src");
  assert.match(large.summary, /45 项/);
  assert.match(large.replayContent, /"compacted":true/);
  assert.doesNotMatch(large.replayContent, /file-44/);
});

test("local file search and mutations replay compact operational summaries", () => {
  const search = buildToolObservation({
    toolName: "filesystem_search",
    toolCallId: "call_search_1",
    content: JSON.stringify({
      path: "src",
      query: "needle",
      matches: Array.from({ length: 20 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        line: index + 1,
        text: `needle match ${index}`
      })),
      truncated: true
    }),
    args: { query: "needle", path: "src", mode: "content" },
    policy: localFileSearchPolicy()
  });
  assert.equal(search.retention, "summary");
  assert.match(search.replayContent, /"mode":"content"/);
  assert.match(search.replayContent, /src\/file-0\.ts/);
  assert.doesNotMatch(search.replayContent, /src\/file-19\.ts/);

  const mutation = buildToolObservation({
    toolName: "filesystem_patch",
    toolCallId: "call_patch_1",
    content: JSON.stringify({
      path: "src/app.ts",
      hunksApplied: 2,
      updatedAtMs: 123
    }),
    args: { path: "src/app.ts" },
    policy: localFileMutationPolicy()
  });
  assert.equal(mutation.retention, "summary");
  assert.match(mutation.replayContent, /"hunksApplied":2/);
  assert.match(mutation.replayContent, /filesystem_read path=src\/app\.ts/);

  const deleted = buildToolObservation({
    toolName: "filesystem_delete",
    toolCallId: "call_delete_1",
    content: JSON.stringify({
      path: "tmp/old.txt",
      deleted: true
    }),
    args: { path: "tmp/old.txt" },
    policy: localFileMutationPolicy()
  });
  assert.equal(deleted.retention, "summary");
  assert.equal(deleted.refetchable, false);
  assert.doesNotMatch(deleted.replayContent, /filesystem_read path=tmp\/old\.txt/);

  const mkdir = buildToolObservation({
    toolName: "filesystem_mkdir",
    toolCallId: "call_mkdir_1",
    content: JSON.stringify({
      path: "tmp/new-dir",
      kind: "directory"
    }),
    args: { path: "tmp/new-dir" },
    policy: localFileMutationPolicy()
  });
  assert.match(mkdir.summary, /创建目录 tmp\/new-dir/);
  assert.doesNotMatch(mkdir.summary, /创建目录本地文件/);
  assert.match(mkdir.replayContent, /filesystem_list path=tmp\/new-dir/);

  const exportedAsset = buildToolObservation({
    toolName: "asset_export_to_filesystem",
    toolCallId: "call_asset_export_1",
    content: JSON.stringify({
      ok: true,
      asset_ref: "report.pdf",
      file_id: "file_report_1",
      from_path: "chat-files/media/report.pdf",
      from_path_role: "asset_store_internal_path",
      to_path: "exports/report.pdf",
      to_path_role: "local_filesystem_path",
      usage_hints: [{
        code: "asset_internal_path",
        message: "chat_file_path 是 asset store 内部路径；需要副本时用 asset_export_to_filesystem。"
      }],
      size_bytes: 10
    }),
    args: { asset_ref: "report.pdf", to_path: "exports/report.pdf" },
    policy: localFileMutationPolicy()
  });
  const exportedReplay = JSON.parse(exportedAsset.replayContent);
  assert.equal(exportedReplay.data.fromPathRole, "asset_store_internal_path");
  assert.equal(exportedReplay.data.toPathRole, "local_filesystem_path");
  assert.equal(exportedReplay.data.usageHints[0].code, "asset_internal_path");
});

test("asset list and send policies keep stable handles without raw records", () => {
  const longCaption = `${"caption ".repeat(200)}tail`;
  const list = buildToolObservation({
    toolName: "asset_list",
    toolCallId: "call_assets",
    content: JSON.stringify({
      ok: true,
      files: Array.from({ length: 20 }, (_, index) => ({
        file_id: `file_${index}`,
        file_ref: `img_${index}.png`,
        kind: "image",
        origin: "browser_download",
        source_name: `image-${index}.png`,
        mime_type: "image/png",
        size_bytes: 100 + index,
        caption_status: "ready",
        caption: longCaption
      })),
      totalMatched: 40,
      returned: 20,
      truncated: true,
      filters: { query: "image", kind: "image", origin: null, limit: 20 }
    }),
    args: { query: "image", kind: "image" },
    policy: chatFileListPolicy()
  });
  assert.equal(list.retention, "summary");
  assert.match(list.replayContent, /"totalMatched":40/);
  assert.match(list.replayContent, /img_0\.png/);
  assert.doesNotMatch(list.replayContent, /img_19\.png/);
  assert.doesNotMatch(list.replayContent, /caption caption caption caption caption caption caption caption caption caption caption caption caption caption/);

  const exact = buildToolObservation({
    toolName: "asset_list",
    toolCallId: "call_asset_exact",
    content: JSON.stringify({
      ok: true,
      file: {
        file_id: "file_exact",
        asset_ref: "img_exact.png",
        kind: "image",
        origin: "browser_download",
        source_name: "exact.png",
        mime_type: "image/png",
        size_bytes: 100,
        caption_status: "missing"
      },
      next_actions: []
    }),
    args: { asset_ref: "img_exact.png" },
    policy: chatFileListPolicy()
  });
  assert.match(exact.replayContent, /"fileCount":1/);
  assert.match(exact.replayContent, /"totalMatched":1/);

  const missing = buildToolObservation({
    toolName: "asset_list",
    toolCallId: "call_asset_missing",
    content: JSON.stringify({
      ok: false,
      file: null
    }),
    args: { asset_ref: "missing.png" },
    policy: chatFileListPolicy()
  });
  assert.equal(missing.resource, undefined);
  assert.equal(missing.refetchable, true);
  assert.match(missing.replayContent, /"ok":false/);
  assert.match(missing.replayContent, /未找到/);
  assert.doesNotMatch(missing.replayContent, /刷新该文件记录/);

  const send = buildToolObservation({
    toolName: "asset_send_to_chat",
    toolCallId: "call_send_file",
    content: JSON.stringify({
      ok: true,
      asset_ref: "img_0.png",
      file_id: "file_0",
      deliveredAs: "image",
      queued: true
    }),
    args: { asset_ref: "img_0.png" },
    policy: fileSendPolicy()
  });
  assert.equal(send.retention, "summary");
  assert.equal(send.preserveRecentRawCount, 0);
  assert.equal(send.resource?.kind, "asset");
  assert.equal(send.resource?.id, "img_0.png");
  assert.match(send.replayContent, /asset_send_to_chat asset_ref/);
});

test("asset local path observation preserves internal path hints", () => {
  const observation = buildToolObservation({
    toolName: "asset_local_path",
    toolCallId: "call_asset_local_path",
    content: JSON.stringify({
      ok: true,
      asset_ref: "report.pdf",
      file_id: "file_report_1",
      path: "chat-files/media/report.pdf",
      path_mode: "asset_store_relative",
      path_role: "asset_store_internal_path",
      source_name: "report.pdf",
      mime_type: "application/pdf",
      size_bytes: 10,
      usage_hints: [{
        code: "asset_internal_path",
        message: "chat_file_path 是 asset store 内部路径；需要副本时用 asset_export_to_filesystem。"
      }]
    }),
    args: { asset_ref: "report.pdf" },
    policy: assetLocalPathPolicy()
  });

  const replay = JSON.parse(observation.replayContent);
  assert.equal(observation.retention, "summary");
  assert.equal(observation.resource?.kind, "asset");
  assert.equal(observation.resource?.id, "report.pdf");
  assert.equal(replay.data.pathMode, "asset_store_relative");
  assert.equal(replay.data.pathRole, "asset_store_internal_path");
  assert.equal(replay.data.usageHints[0].code, "asset_internal_path");
  assert.doesNotMatch(observation.summary, /目录 .* 返回 0 项/);
});

test("media view observation keeps compact asset handles and next actions", () => {
  const observation = buildToolObservation({
    toolName: "asset_media_view",
    toolCallId: "call_view_media",
    content: JSON.stringify({
      ok: true,
      workspace: [{
        file_id: "file_1",
        asset_ref: "chat_0001.png",
        kind: "image",
        origin: "browser_download",
        source_name: "cover.png",
        mime_type: "image/png",
        size_bytes: 123,
        caption: `${"长图说明".repeat(80)}TAIL`
      }],
      asset_handles: [{
        source: "asset",
        asset_id: "file_1",
        asset_ref: "chat_0001.png",
        selector: { asset_id: "file_1", asset_ref: "chat_0001.png" },
        kind: "image",
        source_name: "cover.png",
        mime_type: "image/png",
        size_bytes: 123,
        capabilities: [{
          capability: "send_to_chat",
          tool: "asset_send_to_chat",
          available: true,
          args: { asset_ref: "chat_0001.png" }
        }]
      }],
      audio: [{
        mediaId: "aud_1",
        kind: "audio",
        source: "https://example.com/a.mp3",
        transcriptionStatus: "ready",
        transcription: `${"音频转写".repeat(120)}TAIL`
      }],
      next_actions: [{
        tool: "asset_send_to_chat",
        reason: "发送已查看的媒体文件到当前聊天",
        args: { asset_ref: "chat_0001.png" }
      }]
    }),
    args: { asset_ids: ["file_1"] },
    policy: directMediaViewPolicy()
  });

  const replay = JSON.parse(observation.replayContent);
  assert.equal(observation.retention, "summary");
  assert.equal(observation.resource?.kind, "asset");
  assert.equal(observation.resource?.id, "file_1");
  assert.equal(replay.data.nextActions[0].tool, "asset_send_to_chat");
  assert.equal(replay.data.assetHandles[0].assetRef, "chat_0001.png");
  assert.equal(replay.data.workspace[0].fileRef, "chat_0001.png");
  assert.equal(replay.data.audio[0].mediaId, "aud_1");
  assert.doesNotMatch(observation.replayContent, /TAIL/);
});

test("debug dump observation hides literal bodies from replay and history summary", () => {
  const observation = buildToolObservation({
    toolName: "dump_debug_literals",
    toolCallId: "call_debug",
    content: JSON.stringify({
      ok: true,
      literals: ["full_system_prompt"],
      count: 1,
      messageIds: [123]
    }),
    args: { literals: ["full_system_prompt"] },
    policy: debugDumpPolicy()
  });

  assert.equal(observation.retention, "summary");
  assert.equal(observation.includeInHistorySummary, false);
  assert.equal(observation.preserveRecentRawCount, 0);
  assert.match(observation.replayContent, /full_system_prompt/);
  assert.doesNotMatch(observation.replayContent, /system prompt body/);
});

test("terminal policy compacts shell runtime results with continuation handles", () => {
  const longOutput = `${"line\n".repeat(400)}TAIL-END`;
  const observation = buildToolObservation({
    toolName: "terminal_run",
    toolCallId: "call_terminal_1",
    content: JSON.stringify({
      output: longOutput,
      resource_id: "res_shell_1",
      status: "running",
      command: "npm run dev",
      cwd: "/tmp/project",
      output_truncated: true,
      policy: {
        decision: "allow",
        reason: null,
        warnings: ["command matched warning pattern: sudo"]
      }
    }),
    args: { command: "npm run dev" },
    policy: terminalPolicy()
  });

  assert.equal(observation.retention, "summary");
  assert.equal(observation.resource?.kind, "shell_session");
  assert.equal(observation.resource?.id, "res_shell_1");
  assert.equal(observation.refetchable, true);
  assert.match(observation.replayContent, /npm run dev/);
  assert.match(observation.replayContent, /res_shell_1/);
  assert.match(observation.replayContent, /outputTail/);
  assert.match(observation.replayContent, /"outputTruncated":true/);
  assert.doesNotMatch(observation.replayContent, /line\\nline\\nline\\nline\\nline\\nline\\nline\\nline\\nline\\nline/);
});

test("terminal and browser policies summarize small results so only recent replay keeps raw", () => {
  const terminal = buildToolObservation({
    toolName: "terminal_run",
    toolCallId: "call_terminal_small",
    content: JSON.stringify({
      output: "ok\n",
      status: "completed",
      exitCode: 0,
      command: "echo ok",
      cwd: "/tmp"
    }),
    args: { command: "echo ok" },
    policy: terminalPolicy()
  });
  assert.equal(terminal.retention, "summary");
  assert.match(terminal.replayContent, /echo ok/);

  const browser = buildToolObservation({
    toolName: "open_page",
    toolCallId: "call_browser_small",
    content: JSON.stringify({
      ok: true,
      resource_id: "res_browser_small",
      title: "Tiny",
      resolvedUrl: "https://example.com",
      lines: ["L1 Tiny page"],
      elements: [{ id: 1, role: "link", name: "Home", action: "click" }]
    }),
    args: { url: "https://example.com" },
    policy: browserPagePolicy()
  });
  assert.equal(browser.retention, "summary");
  assert.match(browser.replayContent, /Home/);
});

test("terminal policy summarizes nested session status and pins non-zero nested exit codes", () => {
  const observation = buildToolObservation({
    toolName: "terminal_read",
    toolCallId: "call_terminal_nested",
    content: JSON.stringify({
      output: "failed\n",
      output_truncated: true,
      session: {
        id: "res_shell_nested",
        status: "closed",
        command: "npm test",
        cwd: "/tmp/project",
        exitCode: 1,
        signal: null
      }
    }),
    args: { resource_id: "res_shell_nested" },
    policy: terminalPolicy()
  });

  assert.equal(observation.retention, "summary");
  assert.equal(observation.pinned, true);
  assert.match(observation.replayContent, /npm test/);
  assert.match(observation.replayContent, /"status":"closed"/);
  assert.match(observation.replayContent, /"exitCode":1/);
  assert.match(observation.replayContent, /"outputTruncated":true/);
});

test("terminal policy uses error summaries and only refetches running sessions", () => {
  const errorObservation = buildToolObservation({
    toolName: "terminal_read",
    toolCallId: "call_terminal_error",
    content: JSON.stringify({
      error: "Session res_shell_missing not found"
    }),
    args: { resource_id: "res_shell_missing" },
    policy: terminalPolicy()
  });
  assert.equal(errorObservation.retention, "summary");
  assert.equal(errorObservation.pinned, true);
  assert.match(errorObservation.replayContent, /返回错误/);

  const closedObservation = buildToolObservation({
    toolName: "terminal_read",
    toolCallId: "call_terminal_closed",
    content: JSON.stringify({
      output: "",
      session: {
        id: "res_shell_closed",
        status: "closed",
        exitCode: 0
      }
    }),
    args: { resource_id: "res_shell_closed" },
    policy: terminalPolicy()
  });
  assert.equal(closedObservation.resource?.id, "res_shell_closed");
  assert.equal(closedObservation.refetchable, false);
  assert.doesNotMatch(closedObservation.replayContent, /terminal_read resource_id=res_shell_closed/);
});

test("browser page policy compacts snapshots with line and element samples", () => {
  const observation = buildToolObservation({
    toolName: "interact_with_page",
    toolCallId: "call_browser_1",
    content: JSON.stringify({
      ok: true,
      resource_id: "res_browser_1",
      action: "click",
      message: "已命中元素 #1。",
      snapshot: {
        resource_id: "res_browser_1",
        title: "Docs",
        resolvedUrl: "https://example.com/docs",
        revision: 3,
        lineStart: 1,
        lineEnd: 40,
        truncated: true,
        lines: Array.from({ length: 50 }, (_, index) => `L${index + 1} docs line ${index + 1}`),
        elements: Array.from({ length: 30 }, (_, index) => ({
          id: index + 1,
          role: "button",
          name: `Button ${index + 1}`,
          action: "click"
        }))
      }
    }),
    args: { resource_id: "res_browser_1", action: "click" },
    policy: browserPagePolicy()
  });

  assert.equal(observation.retention, "summary");
  assert.equal(observation.resource?.kind, "browser_page");
  assert.equal(observation.resource?.id, "res_browser_1");
  assert.equal(observation.resource?.locator, "L1-L40");
  assert.equal(observation.resource?.version, "https://example.com/docs");
  assert.match(observation.replayContent, /Button 1/);
  assert.match(observation.replayContent, /lineWindow/);
  assert.match(observation.replayContent, /"truncated":true/);
  assert.doesNotMatch(observation.replayContent, /Button 30/);
});

test("browser screenshot and download policies replay stable file handles only", () => {
  const screenshot = buildToolObservation({
    toolName: "capture_screenshot",
    toolCallId: "call_screenshot_1",
    content: JSON.stringify({
      ok: true,
      resource_id: "res_browser_1",
      fileId: "file_screenshot_1",
      fileRef: "chat:file_screenshot_1",
      mode: "page",
      mimeType: "image/png",
      sizeBytes: 1234
    }),
    args: { resource_id: "res_browser_1" },
    policy: browserScreenshotPolicy()
  });
  assert.equal(screenshot.preserveRecentRawCount, 0);
  assert.equal(screenshot.resource?.kind, "asset");
  assert.equal(screenshot.resource?.id, "file_screenshot_1");
  assert.match(screenshot.replayContent, /file_screenshot_1/);

  const download = buildToolObservation({
    toolName: "download_asset",
    toolCallId: "call_download_1",
    content: JSON.stringify({
      ok: true,
      file_id: "file_download_1",
      asset_ref: "chat:file_download_1",
      kind: "image",
      source_url: "https://example.com/image.png",
      resource_id: "res_browser_1",
      mime_type: "image/png",
      size_bytes: 4321
    }),
    args: { resource_id: "res_browser_1" },
    policy: browserDownloadPolicy()
  });
  assert.equal(download.preserveRecentRawCount, 0);
  assert.equal(download.resource?.kind, "asset");
  assert.equal(download.resource?.id, "file_download_1");
  assert.match(download.replayContent, /sourceUrl/);
  assert.match(download.replayContent, /asset_send_to_chat/);
});

test("policy failures produce safe compacted observations without raw replay", () => {
  const rawSecret = JSON.stringify({ ok: true, body: "VERY_SECRET_LITERAL" });
  const failingPolicy: ToolResultObservationPolicy = {
    method() {
      throw new Error("method boom");
    },
    replaySafe: false,
    preserveRecentRawCount: 0
  };

  const observation = buildToolObservation({
    toolName: "custom_sensitive_tool",
    toolCallId: "call_policy_fail",
    content: rawSecret,
    policy: failingPolicy
  });

  assert.equal(observation.retention, "summary");
  assert.equal(observation.replaySafe, false);
  assert.equal(observation.preserveRecentRawCount, 0);
  assert.match(observation.summary, /观察策略执行失败/);
  assert.match(observation.replayContent, /method boom/);
  assert.doesNotMatch(observation.replayContent, /VERY_SECRET_LITERAL/);
});

test("compactor failures produce safe compacted observations without raw replay", () => {
  const rawSecret = JSON.stringify({ ok: true, body: "COMPACTOR_SECRET_LITERAL" });
  const failingPolicy: ToolResultObservationPolicy = {
    method() {
      return "broken";
    },
    compactors: {
      broken() {
        throw new Error("compactor boom");
      }
    }
  };

  const observation = buildToolObservation({
    toolName: "custom_sensitive_tool",
    toolCallId: "call_compactor_fail",
    content: rawSecret,
    policy: failingPolicy
  });

  assert.equal(observation.retention, "summary");
  assert.match(observation.summary, /观察策略执行失败/);
  assert.match(observation.replayContent, /compactor boom/);
  assert.doesNotMatch(observation.replayContent, /COMPACTOR_SECRET_LITERAL/);
});

test("current group context observations compact results and preserve refetch hints", () => {
  const tools = [
    {
      name: "view_current_group_info",
      content: {
        ok: true,
        groupId: "123456",
        groupName: "测试群",
        summary: "当前群 测试群 (123456)，成员 42"
      },
      expectedLocator: "info",
      expectedHint: /view_current_group_info/
    },
    {
      name: "list_current_group_announcements",
      content: {
        ok: true,
        groupId: "123456",
        query: "维护",
        limit: 10,
        count: 1,
        summary: "当前群 123456 公告查询返回 1/1 条，limit=10，query=\"维护\"",
        items: [{ id: "n1", title: "维护通知", content: "今晚维护" }]
      },
      expectedLocator: "announcements query=\"维护\" limit=10",
      expectedHint: /list_current_group_announcements query=\\"维护\\" limit=10/
    },
    {
      name: "view_current_group_announcement",
      content: {
        ok: true,
        groupId: "123456",
        announcementId: "n1",
        title: "维护通知",
        startLine: 2,
        requestedLineCount: 20,
        endLine: 5,
        nextStartLine: 6,
        summary: "当前群 123456 公告 n1，标题「维护通知」，行 2-5/10",
        content: "第二行\n第三行"
      },
      expectedLocator: "announcement id=\"n1\" L2-L5",
      expectedHint: /view_current_group_announcement announcementId=\\"n1\\" startLine=6 lineCount=20/
    },
    {
      name: "list_current_group_members",
      content: {
        ok: true,
        groupId: "123456",
        query: "Alice",
        limit: 20,
        count: 1,
        summary: "当前群 123456 成员查询返回 1/1 人，limit=20，query=\"Alice\"",
        items: [{ userId: "10001", displayName: "Alice" }]
      },
      expectedLocator: "members query=\"Alice\" limit=20",
      expectedHint: /list_current_group_members query=\\"Alice\\" limit=20/
    }
  ];

  for (const tool of tools) {
    const observation = buildToolObservation({
      toolName: tool.name,
      toolCallId: `call-${tool.name}`,
      content: JSON.stringify(tool.content)
    });

    assert.equal(observation.retention, "summary");
    assert.equal(observation.resource?.kind, "external");
    assert.equal(observation.resource?.id, "onebot:group:123456");
    assert.equal(observation.resource?.locator, tool.expectedLocator);
    assert.equal(observation.refetchable, true);
    assert.match(observation.replayContent, /"compacted":true/);
    assert.match(observation.replayContent, tool.expectedHint);
  }
});

test("current group announcement detail observation preserves long content excerpts", () => {
  const observation = buildToolObservation({
    toolName: "view_current_group_announcement",
    toolCallId: "call_group_announcement_detail",
    content: JSON.stringify({
      ok: true,
      groupId: "123456",
      announcementId: "n1",
      title: "长公告",
      startLine: 1,
      endLine: 80,
      totalLines: 120,
      nextStartLine: 81,
      requestedLineCount: 80,
      lineTruncated: true,
      charTruncated: false,
      summary: "当前群 123456 公告 n1，行 1-80/120",
      content: "IMPORTANT_GROUP_ANNOUNCEMENT_CONTENT\n".repeat(300)
    })
  });

  assert.equal(observation.retention, "summary");
  assert.match(observation.replayContent, /IMPORTANT_GROUP_ANNOUNCEMENT_CONTENT/);
  assert.match(observation.replayContent, /nextStartLine/);
  assert.match(observation.replayContent, /startLine=81/);
});

test("tool_result transcript schema accepts optional observation metadata", () => {
  const observation = buildToolObservation({
    toolName: "terminal_run",
    toolCallId: "call_shell_1",
    content: JSON.stringify({
      stdout: "ok\n".repeat(100),
      stderr: "",
      exitCode: 0
    })
  });

  const parsed = internalTranscriptItemSchema.parse({
    kind: "tool_result",
    llmVisible: true,
    timestampMs: 1,
    toolCallId: "call_shell_1",
    toolName: "terminal_run",
    content: JSON.stringify({ stdout: "ok\n".repeat(100), stderr: "", exitCode: 0 }),
    observation
  });

  assert.equal(parsed.kind, "tool_result");
  assert.equal(parsed.observation?.resource?.kind, "shell_session");
  assert.equal(parsed.observation?.retention, "summary");
});

test("compression snapshot and summary prompt include compacted tool observations", () => {
  const observation = buildToolObservation({
    toolName: "filesystem_read",
    toolCallId: "tool-1",
    content: JSON.stringify({
      path: "src/conversation/session/sessionTranscript.ts",
      content: "旧工具读取内容\n".repeat(120),
      startLine: 180,
      endLine: 240,
      totalLines: 360,
      truncated: true
    })
  });
  const transcript: InternalTranscriptItem[] = [
    createHistoryMessage("user", "old user", 1),
    {
      kind: "assistant_tool_call",
      llmVisible: true,
      timestampMs: 2,
      content: "",
      toolCalls: [{
        id: "tool-1",
        type: "function",
        function: {
          name: "filesystem_read",
          arguments: "{\"path\":\"src/conversation/session/sessionTranscript.ts\"}"
        }
      }]
    } as any,
    {
      kind: "tool_result",
      llmVisible: true,
      timestampMs: 3,
      toolCallId: "tool-1",
      toolName: "filesystem_read",
      content: JSON.stringify({ path: "src/conversation/session/sessionTranscript.ts", content: "旧工具读取内容" }),
      observation
    },
    createHistoryMessage("assistant", "old assistant", 4),
    createHistoryMessage("user", "new user", 5),
    createHistoryMessage("assistant", "new assistant", 6)
  ];

  const snapshot = projectCompressionHistorySnapshot({
    historySummary: null,
    internalTranscript: transcript
  } as any, createTestAppConfig(), 0, 2);

  assert.ok(snapshot);
  assert.equal(snapshot.toolObservationsToCompress.length, 1);
  assert.match(snapshot.toolObservationsToCompress[0]?.summary ?? "", /sessionTranscript\.ts/);

  const prompt = buildHistorySummaryPrompt({
    sessionId: "qqbot:p:test",
    existingSummary: null,
    messagesToCompress: snapshot.messagesToCompress,
    toolObservationsToCompress: snapshot.toolObservationsToCompress
  });

  assert.match(String(prompt[1]?.content ?? ""), /summary_source_tool_observations/);
  assert.match(String(prompt[1]?.content ?? ""), /filesystem_read/);
  assert.match(String(prompt[1]?.content ?? ""), /sessionTranscript\.ts/);
});

test("derived observation adapters expose tool, image, and audio observations without persistence migration", () => {
  const observation = buildToolObservation({
    toolName: "filesystem_read",
    toolCallId: "tool-1",
    content: JSON.stringify({
      path: "src/conversation/session/toolObservation.ts",
      content: "工具内容",
      startLine: 1,
      endLine: 20
    })
  });

  assert.deepEqual(toolObservationToDerivedObservation("tool-1", observation), {
    sourceKind: "tool_result",
    sourceId: "tool-1",
    purpose: "tool_replay_compaction",
    status: "ready",
    text: observation.summary,
    sourceHash: observation.contentHash
  });

  assert.deepEqual(imageCaptionToDerivedObservation("file_1", "  一张猫图  "), {
    sourceKind: "asset",
    sourceId: "file_1",
    purpose: "image_caption",
    status: "ready",
    text: "一张猫图"
  });

  assert.deepEqual(audioTranscriptionToDerivedObservation({
    id: "aud_1",
    source: "https://example.com/a.mp3",
    createdAt: 1,
    transcription: "你好",
    transcriptionStatus: "ready",
    transcriptionUpdatedAt: 2,
    transcriptionModelRef: "audio-model",
    transcriptionError: null
  }), {
    sourceKind: "audio",
    sourceId: "aud_1",
    purpose: "audio_transcription",
    status: "ready",
    text: "你好",
    modelRef: "audio-model",
    updatedAt: 2,
    error: null
  });
});

function createHistoryMessage(role: "user" | "assistant", text: string, timestampMs: number): InternalTranscriptItem {
  if (role === "user") {
    return {
      kind: "user_message",
      role,
      llmVisible: true,
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text,
      imageIds: [],
      emojiIds: [],
      attachments: [],
      messageFiles: [],
      audioCount: 0,
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      mentionedSelf: false,
      timestampMs
    };
  }
  return {
    kind: "assistant_message",
    role,
    llmVisible: true,
    chatType: "private",
    userId: "bot",
    senderName: "Bot",
    text,
    timestampMs
  };
}
