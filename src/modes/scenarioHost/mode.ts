import type { SessionModeDefinition } from "../types.ts";

export const scenarioHostModeDefinition: SessionModeDefinition = {
  id: "scenario_host",
  title: "Scenario Host",
  description: "轻规则单人剧情主持模式。当前仅支持私聊。",
  allowedChatTypes: ["private"],
  defaultToolsetIds: [
    "chat_context",
    "time_utils",
    "scenario_host_state"
  ],
  setupPhase: {
    needsSetup({ sessionStateInitialized, setupConfirmedByUser }) {
      return !sessionStateInitialized && !setupConfirmedByUser;
    },
    setupToolsetOverrides: [
      {
        toolsetId: "scenario_setup_state",
        title: "场景状态（初始化）",
        description: "初始化阶段用于填写场景基础信息。",
        toolNames: ["get_scenario_state", "update_scenario_state", "set_current_location"],
        promptGuidance: ["收集到足够信息后逐字段写入；不要一次性追问所有字段，也不要编造设定。"],
        plannerSignals: ["写入场景初始信息"]
      },
      {
        toolsetId: "setup_draft",
        title: "设定草稿",
        description: "以独立消息发送当前场景草稿供用户审阅。",
        toolNames: ["send_setup_draft"],
        promptGuidance: ["收集到一定量信息后，用此工具发送格式化草稿；不要在回复正文中列出草稿内容。"],
        plannerSignals: ["发送场景草稿"]
      }
    ],
    promptMode: "chat_with_setup_injection",
    completionSignal: "user_command",
    onComplete: "none"
  }
};
