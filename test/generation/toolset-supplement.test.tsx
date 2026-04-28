import test from "node:test";
import assert from "node:assert/strict";
import { supplementPlannedToolsets } from "../../src/app/generation/toolsetSupplement.ts";

const AVAILABLE_TOOLSETS = [
  { id: "chat_context", title: "会话上下文", description: "", toolNames: ["view_message", "chat_file_view_media"] },
  { id: "web_research", title: "网页检索与浏览", description: "", toolNames: ["open_page", "inspect_page", "download_asset"] },
  { id: "shell_runtime", title: "Shell 运行时", description: "", toolNames: ["terminal_run"] },
  { id: "local_file_io", title: "本地文件", description: "", toolNames: ["local_file_read", "local_file_mkdir"] },
  { id: "memory_profile", title: "长期资料与规则", description: "", toolNames: ["upsert_user_memory"] },
  { id: "scheduler_admin", title: "定时任务管理", description: "", toolNames: ["create_scheduled_job"] },
  { id: "dice_roller", title: "骰子", description: "", toolNames: ["roll_dice"] }
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

  test("supplement adds chat_context for structured content", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      batchMessages: [createBatchMessage({ replyMessageId: "msg-1", text: "你接着说" })],
      recentToolEvents: [],
      plannerDecision: {
        reason: "需要看引用",
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        requiredCapabilities: [],
        contextDependencies: ["structured_message_context"],
        recentDomainReuse: [],
        followupMode: "explicit_reference",
        toolsetIds: []
      }
    });
    assert.deepEqual(result.toolsetIds, ["chat_context"]);
  });

  test("supplement maps planner capabilities to final toolsets without regex intent tables", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      batchMessages: [createBatchMessage({ text: "把这个页面里的图下下来保存到本地文件里" })],
      recentToolEvents: [],
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
      batchMessages: [createBatchMessage({ text: "打开页面，把里面的图片下载下来" })],
      recentToolEvents: [],
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
      batchMessages: [createBatchMessage({ text: "记住我以后叫我老王" })],
      recentToolEvents: [],
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

  test("supplement adds dice_roller for dice notation without planner help", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      batchMessages: [createBatchMessage({ text: "帮我投 3D6+5+1D20" })],
      recentToolEvents: [],
      plannerDecision: {
        reason: "需要投骰",
        replyDecision: "reply_small",
        topicDecision: "continue_topic",
        requiredCapabilities: [],
        contextDependencies: [],
        recentDomainReuse: [],
        followupMode: "none",
        toolsetIds: []
      }
    });
    assert.deepEqual(result.toolsetIds, ["dice_roller"]);
    assert.deepEqual(result.addedToolsetIds, ["dice_roller"]);
  });

  test("supplement inherits recent browser activity for short followups", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      batchMessages: [createBatchMessage({ text: "继续，点进去看看" })],
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

  test("supplement inherits recent shell activity for short followups", async () => {
    const result = supplementPlannedToolsets({
      selectedToolsetIds: [],
      availableToolsets: AVAILABLE_TOOLSETS,
      batchMessages: [createBatchMessage({ text: "继续看看" })],
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
      recentToolEvents: [{
        toolName: "terminal_run",
        argsSummary: "cmd=npm test",
        outcome: "success",
        resultSummary: "running",
        timestampMs: Date.now() - 1000
      }]
    });
    assert.deepEqual(result.toolsetIds, ["shell_runtime"]);
  });
