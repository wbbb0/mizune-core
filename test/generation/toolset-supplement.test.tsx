import assert from "node:assert/strict";
import { supplementPlannedToolsets } from "../../src/app/generation/toolsetSupplement.ts";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

const AVAILABLE_TOOLSETS = [
  { id: "chat_context", title: "会话上下文", description: "", toolNames: ["view_message", "view_media"] },
  { id: "web_research", title: "网页检索与浏览", description: "", toolNames: ["open_page", "inspect_page"] },
  { id: "shell_runtime", title: "Shell 运行时", description: "", toolNames: ["shell_run"] },
  { id: "workspace_io", title: "工作区文件", description: "", toolNames: ["download_asset", "read_workspace_file"] },
  { id: "memory_profile", title: "记忆与资料", description: "", toolNames: ["write_memory"] },
  { id: "scheduler_admin", title: "定时任务管理", description: "", toolNames: ["create_scheduled_job"] }
];

function createBatchMessage(overrides: Partial<Parameters<typeof supplementPlannedToolsets>[0]["batchMessages"][number]> = {}) {
  return {
    chatType: "private" as const,
    userId: "u1",
    senderName: "Tester",
    text: "",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    attachments: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    isAtMentioned: false,
    receivedAt: Date.now(),
    ...overrides
  };
}

async function main() {
  await runCase("supplement adds chat_context for structured content", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      batchMessages: [createBatchMessage({ replyMessageId: "msg-1", text: "你接着说" })],
      recentToolEvents: []
    });
    assert.deepEqual(result.toolsetIds, ["chat_context"]);
  });

  await runCase("supplement links web download flows to workspace_io", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: ["web_research"],
      availableToolsets: AVAILABLE_TOOLSETS,
      batchMessages: [createBatchMessage({ text: "把这个页面里的图下下来保存到工作区" })],
      recentToolEvents: []
    });
    assert.deepEqual(result.toolsetIds, ["web_research", "workspace_io"]);
    assert.deepEqual(result.addedToolsetIds, ["workspace_io"]);
  });

  await runCase("supplement inherits recent browser activity for short followups", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      batchMessages: [createBatchMessage({ text: "继续，点进去看看" })],
      recentToolEvents: [{
        toolName: "open_page",
        argsSummary: "url=https://example.com",
        outcome: "success",
        resultSummary: "opened",
        timestampMs: Date.now() - 1000
      }]
    });
    assert.deepEqual(result.toolsetIds, ["web_research"]);
  });

  await runCase("supplement inherits recent shell activity for short followups", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      batchMessages: [createBatchMessage({ text: "继续看看" })],
      recentToolEvents: [{
        toolName: "shell_run",
        argsSummary: "cmd=npm test",
        outcome: "success",
        resultSummary: "running",
        timestampMs: Date.now() - 1000
      }]
    });
    assert.deepEqual(result.toolsetIds, ["shell_runtime"]);
  });
}

void main();
