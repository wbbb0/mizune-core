import type { SessionModeDefinition } from "./types.ts";

export const rpAssistantModeDefinition: SessionModeDefinition = {
  id: "rp_assistant",
  title: "RP Assistant",
  description: "当前默认模式。保留现有角色扮演 + 助手能力。",
  allowedChatTypes: ["private", "group"],
  defaultToolsetIds: [
    "chat_context",
    "memory_profile",
    "conversation_navigation",
    "chat_delegation",
    "web_research",
    "shell_runtime",
    "local_file_io",
    "chat_file_io",
    "social_admin",
    "scheduler_admin",
    "comfy_image",
    "time_utils",
    "debug_owner"
  ],
  setupPhase: {
    needsSetup({ globalSetupReady, chatType, relationship }) {
      return !globalSetupReady && chatType === "private" && relationship === "owner";
    },
    setupToolsetOverrides: [
      {
        toolsetId: "memory_profile",
        title: "记忆与资料",
        description: "初始化阶段仅允许写入 persona 相关资料。",
        toolNames: ["read_memory", "write_memory"],
        promptGuidance: ["初始化阶段只补全 persona；不要改用户资料、关系或其他记忆。"],
        plannerSignals: ["初始化 persona 补全"]
      }
    ],
    promptMode: "persona_setup",
    completionSignal: "global_setup_ready",
    onComplete: "clear_session"
  }
};
