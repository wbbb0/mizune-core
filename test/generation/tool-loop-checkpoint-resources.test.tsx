import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { collectToolLoopCheckpointResourceLines } from "../../src/app/generation/toolLoopCheckpointResources.ts";
import type { ToolLoopCheckpointObservation } from "../../src/llm/prompts/tool-loop-checkpoint.prompt.ts";

test("checkpoint resource refresh reads only resources referenced by current tool observations", async () => {
  const calls: string[] = [];
  const observations: ToolLoopCheckpointObservation[] = [
    observation("terminal_start", "shell_session", "term-1"),
    observation("open_page", "browser_page", "page-1"),
    observation("download_url", "external", "download:res_download_1")
  ];

  const lines = await collectToolLoopCheckpointResourceLines({
    observations,
    shellRuntime: {
      async listSessionResources() {
        calls.push("shell:list");
        return [
          { resource_id: "term-1", title: "测试服务" },
          { resource_id: "term-unreferenced", title: "不应展示" }
        ] as never;
      }
    },
    browserService: {
      async listPages() {
        calls.push("browser:list");
        return {
          ok: true,
          pages: [
            { resource_id: "page-1", title: "文档" },
            { resource_id: "page-unreferenced", title: "不应展示" }
          ]
        } as never;
      }
    },
    downloadRuntime: {
      read(resourceId: string) {
        calls.push(`download:${resourceId}`);
        return {
          resource_id: resourceId,
          status: "running",
          phase: "transferring",
          percent: 42.5,
          error: null
        } as never;
      }
    },
    logger: pino({ level: "silent" }),
    sessionId: "session-1",
    assertCurrent() {}
  });

  assert.deepEqual(calls.sort(), ["browser:list", "download:res_download_1", "shell:list"]);
  assert.deepEqual(lines, [
    "终端 term-1：仍在运行（测试服务）",
    "浏览器页面 page-1：仍处于活动状态（文档）",
    "下载 res_download_1：仍在运行（传输阶段），进度 43%"
  ]);
  assert.doesNotMatch(lines.join("\n"), /unreferenced|不应展示/);
});

function observation(
  toolName: string,
  kind: string,
  id: string
): ToolLoopCheckpointObservation {
  return {
    toolName,
    toolCallId: `call-${id}`,
    outcome: "in_progress",
    summary: `${toolName} 正在进行`,
    timestampMs: 1,
    contentHash: `hash-${id}`,
    resource: { kind, id }
  };
}
