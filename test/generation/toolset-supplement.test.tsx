import test from "node:test";
import assert from "node:assert/strict";
import { supplementPlannedToolsets } from "../../src/app/generation/toolsetSupplement.ts";
import type { InternalTranscriptItem } from "../../src/conversation/session/sessionTypes.ts";

const AVAILABLE_TOOLSETS = [
  { id: "chat_context", title: "会话上下文", description: "", toolNames: ["view_message", "chat_file_view_media"] },
  { id: "web_research", title: "网页检索与浏览", description: "", toolNames: ["open_page", "inspect_page", "download_asset"] },
  { id: "shell_runtime", title: "Shell 运行时", description: "", toolNames: ["terminal_run"] },
  { id: "local_file_io", title: "本地文件", description: "", toolNames: ["local_file_read", "local_file_mkdir"] },
  { id: "memory_profile", title: "长期资料与规则", description: "", toolNames: ["upsert_user_memory"] },
  { id: "scheduler_admin", title: "定时任务管理", description: "", toolNames: ["create_scheduled_job"] },
  { id: "dice_roller", title: "骰子", description: "", toolNames: ["roll_dice"] }
];

function toolResult(toolName: string): InternalTranscriptItem {
  return {
    kind: "tool_result",
    llmVisible: true,
    timestampMs: Date.now() - 1000,
    toolCallId: `call-${toolName}`,
    toolName,
    content: "{}"
  } as InternalTranscriptItem;
}

  test("supplement maps planner capabilities to final toolsets without regex intent tables", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      recentTranscriptItems: [],
      plannerDecision: {
        reason: "需要打开网页并存本地",
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        requiredCapabilities: ["web_navigation", "local_file_access"],
        contextDependencies: [],
        recentDomainReuse: [],
        followupMode: "none",
        toolsetIds: []
      }
    });
    assert.deepEqual(result.toolsetIds, ["web_research", "local_file_io"]);
    assert.deepEqual(result.addedToolsetIds, ["web_research", "local_file_io"]);
  });

  test("supplement treats browser downloads as web navigation", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      recentTranscriptItems: [],
      plannerDecision: {
        reason: "需要在网页里定位并下载资源",
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        requiredCapabilities: ["web_navigation"],
        contextDependencies: [],
        recentDomainReuse: [],
        followupMode: "none",
        toolsetIds: []
      }
    });
    assert.deepEqual(result.toolsetIds, ["web_research"]);
    assert.deepEqual(result.addedToolsetIds, ["web_research"]);
  });

  test("supplement maps memory_write to memory_profile explicitly", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      recentTranscriptItems: [],
      plannerDecision: {
        reason: "需要判断是否更新长期记忆",
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        requiredCapabilities: ["memory_write"],
        contextDependencies: [],
        recentDomainReuse: [],
        followupMode: "none",
        toolsetIds: []
      }
    });
    assert.deepEqual(result.toolsetIds, ["memory_profile"]);
    assert.deepEqual(result.addedToolsetIds, ["memory_profile"]);
  });

  test("supplement inherits recent browser activity for short followups", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      plannerDecision: {
        reason: "延续上轮操作",
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        requiredCapabilities: [],
        contextDependencies: [],
        recentDomainReuse: [],
        followupMode: "elliptical",
        toolsetIds: []
      },
      recentTranscriptItems: [toolResult("open_page")]
    });
    assert.deepEqual(result.toolsetIds, ["web_research"]);
  });

  test("supplement inherits recent shell activity for short followups", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      plannerDecision: {
        reason: "延续终端排查",
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        requiredCapabilities: [],
        contextDependencies: [],
        recentDomainReuse: [],
        followupMode: "elliptical",
        toolsetIds: []
      },
      recentTranscriptItems: [toolResult("terminal_run")]
    });
    assert.deepEqual(result.toolsetIds, ["shell_runtime"]);
  });
