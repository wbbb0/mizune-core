import test from "node:test";
import assert from "node:assert/strict";
import { resolveAutoActivatedToolsets } from "../../src/app/generation/toolsetAutoActivation.ts";
import type { ToolsetView } from "../../src/llm/tools/toolsetCatalog.ts";

const AVAILABLE_TOOLSETS: ToolsetView[] = [
  { id: "chat_context", title: "会话上下文", description: "", toolNames: ["view_message", "chat_file_view_media"] },
  { id: "web_research", title: "网页检索与浏览", description: "", toolNames: ["open_page"] },
  { id: "dice_roller", title: "骰子", description: "", toolNames: ["roll_dice"] },
  { id: "scenario_host_state", title: "场景状态", description: "", toolNames: ["get_scenario_state"] }
];

function createBatchMessage(overrides: Partial<Parameters<typeof resolveAutoActivatedToolsets>[0]["batchMessages"][number]> = {}) {
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

function createPlannerDecision(overrides: Partial<NonNullable<Parameters<typeof resolveAutoActivatedToolsets>[0]["plannerDecision"]>> = {}) {
  return {
    reason: "继续追问上下文",
    replyDecision: "reply_small" as const,
    topicDecision: "continue_topic" as const,
    requiredCapabilities: [],
    contextDependencies: [],
    recentDomainReuse: [],
    followupMode: "none" as const,
    toolsetIds: [],
    ...overrides
  };
}

test("auto activation adds chat_context for current structured chat content", () => {
  const result = resolveAutoActivatedToolsets({
    availableToolsets: AVAILABLE_TOOLSETS,
    batchMessages: [createBatchMessage({ replyMessageId: "msg-1", text: "这条是什么意思" })],
    recentMessages: [],
    modeId: "assistant",
    plannerDecision: null
  });

  assert.deepEqual(result.toolsetIds, ["chat_context"]);
  assert.deepEqual(result.addedToolsetIds, ["chat_context"]);
  assert.deepEqual(result.reasons, ["chat_context:current_structured_chat_content"]);
});

test("auto activation adds chat_context for prior image refs only when the planner marks a follow-up", () => {
  const result = resolveAutoActivatedToolsets({
    availableToolsets: AVAILABLE_TOOLSETS,
    batchMessages: [createBatchMessage({ text: "读表函数有哪些" })],
    recentMessages: [{
      role: "user",
      content: "测试，能不能看到图\n⟦ref kind=\"image\" image_id=\"file_1\"⟧\n图片描述：表格截图",
      timestampMs: 1
    }],
    modeId: "assistant",
    plannerDecision: createPlannerDecision({ followupMode: "explicit_reference" })
  });

  assert.deepEqual(result.toolsetIds, ["chat_context"]);
  assert.deepEqual(result.addedToolsetIds, ["chat_context"]);
  assert.deepEqual(result.reasons, ["chat_context:recent_structured_chat_content"]);
});

test("auto activation does not add chat_context for unrelated turns after old image refs", () => {
  const result = resolveAutoActivatedToolsets({
    availableToolsets: AVAILABLE_TOOLSETS,
    batchMessages: [createBatchMessage({ text: "今天星期几" })],
    recentMessages: [{
      role: "user",
      content: "之前的图\n⟦ref kind=\"image\" image_id=\"file_1\"⟧\n图片描述：表格截图",
      timestampMs: 1
    }],
    modeId: "assistant",
    plannerDecision: createPlannerDecision()
  });

  assert.deepEqual(result.toolsetIds, []);
  assert.deepEqual(result.addedToolsetIds, []);
  assert.deepEqual(result.reasons, []);
});

test("auto activation adds chat_context for planner structured context metadata", () => {
  const result = resolveAutoActivatedToolsets({
    availableToolsets: AVAILABLE_TOOLSETS,
    batchMessages: [createBatchMessage({ text: "继续看上面那张" })],
    recentMessages: [{
      role: "user",
      content: "⟦ref kind=\"image\" image_id=\"file_1\"⟧",
      timestampMs: 1
    }],
    modeId: "assistant",
    plannerDecision: createPlannerDecision({
      contextDependencies: ["structured_message_context"],
      followupMode: "none"
    })
  });

  assert.deepEqual(result.toolsetIds, ["chat_context"]);
  assert.deepEqual(result.addedToolsetIds, ["chat_context"]);
  assert.deepEqual(result.reasons, ["chat_context:recent_structured_chat_content"]);
});

test("auto activation leaves dice_roller to planner selection", () => {
  const result = resolveAutoActivatedToolsets({
    availableToolsets: AVAILABLE_TOOLSETS,
    batchMessages: [createBatchMessage({ text: "帮我投 3D6+5" })],
    recentMessages: [],
    modeId: "assistant",
    plannerDecision: null
  });

  assert.deepEqual(result.toolsetIds, []);
  assert.deepEqual(result.addedToolsetIds, []);
  assert.deepEqual(result.reasons, []);
});

test("auto activation adds scenario_host_state in scenario_host mode", () => {
  const result = resolveAutoActivatedToolsets({
    availableToolsets: AVAILABLE_TOOLSETS,
    batchMessages: [createBatchMessage({ text: "继续" })],
    recentMessages: [],
    modeId: "scenario_host",
    plannerDecision: null
  });

  assert.deepEqual(result.toolsetIds, ["scenario_host_state"]);
  assert.deepEqual(result.addedToolsetIds, ["scenario_host_state"]);
  assert.deepEqual(result.reasons, ["scenario_host_state:scenario_host_mode"]);
});

test("auto activation respects available toolsets", () => {
  const result = resolveAutoActivatedToolsets({
    availableToolsets: AVAILABLE_TOOLSETS.filter((item) => item.id !== "chat_context"),
    batchMessages: [createBatchMessage({ replyMessageId: "msg-1" })],
    recentMessages: [{
      role: "user",
      content: "⟦ref kind=\"image\" image_id=\"file_1\"⟧",
      timestampMs: 1
    }],
    modeId: "assistant",
    plannerDecision: createPlannerDecision({ contextDependencies: ["structured_message_context"] })
  });

  assert.deepEqual(result.toolsetIds, []);
  assert.deepEqual(result.addedToolsetIds, []);
  assert.deepEqual(result.reasons, []);
});

test("auto activation preserves selected toolsets and available ordering", () => {
  const result = resolveAutoActivatedToolsets({
    availableToolsets: AVAILABLE_TOOLSETS,
    selectedToolsetIds: ["web_research"],
    batchMessages: [createBatchMessage({ replyMessageId: "msg-1" })],
    recentMessages: [],
    modeId: "scenario_host",
    plannerDecision: null
  });

  assert.deepEqual(result.toolsetIds, ["chat_context", "web_research", "scenario_host_state"]);
  assert.deepEqual(result.addedToolsetIds, ["chat_context", "scenario_host_state"]);
  assert.deepEqual(result.reasons, [
    "chat_context:current_structured_chat_content",
    "scenario_host_state:scenario_host_mode"
  ]);
});
