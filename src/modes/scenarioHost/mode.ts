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
    resolveOperationModeKind({ personaReady, modeProfileReady, operationMode, chatType, relationship }) {
      if (operationMode.kind === "persona_setup" || operationMode.kind === "mode_setup") {
        return operationMode.kind;
      }
      if (chatType !== "private" || relationship !== "owner") {
        return null;
      }
      if (!personaReady) {
        return "persona_setup";
      }
      return modeProfileReady ? null : "mode_setup";
    },
    operations: [
      {
        kind: "persona_setup",
        setupToolsetOverrides: [
          {
            toolsetId: "memory_profile",
            title: "长期资料与规则",
            description: "初始化阶段仅允许写入 persona 相关资料。",
            toolNames: ["get_persona", "patch_persona", "clear_persona_field"],
            promptGuidance: ["初始化阶段只补全 persona；不要改用户资料、关系或其他记忆。"],
            plannerSignals: ["初始化 persona 补全"]
          },
          {
            toolsetId: "setup_draft",
            title: "设定草稿",
            description: "以独立消息发送当前设定草稿供用户审阅。",
            toolNames: ["send_setup_draft"],
            promptGuidance: ["设定字段收集到一定程度后，用此工具发送格式化草稿；不要在回复正文中列出草稿内容。"],
            plannerSignals: ["发送设定草稿"]
          }
        ],
        promptMode: "persona_setup",
        completionSignal: "user_command",
        onComplete: "clear_session"
      },
      {
        kind: "mode_setup",
        setupToolsetOverrides: [
          {
            toolsetId: "scenario_profile_draft",
            title: "Scenario 资料草稿",
            description: "初始化阶段用于填写 Scenario 全局资料草稿。",
            toolNames: ["get_scenario_profile", "patch_scenario_profile", "clear_scenario_profile_field"],
            promptGuidance: ["初始化阶段只补全 Scenario 全局资料；不要改 persona、用户资料或其他记忆。"],
            plannerSignals: ["写入 Scenario 全局资料"]
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
        onComplete: "clear_session"
      }
    ]
  }
};
