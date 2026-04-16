import type { SessionModeDefinition } from "./types.ts";

export const assistantModeDefinition: SessionModeDefinition = {
  id: "assistant",
  title: "Assistant",
  description: "普通助手模式。不读取 persona、记忆或用户资料，仅保留本会话功能工具。",
  allowedChatTypes: ["private", "group"],
  defaultToolsetIds: [
    "chat_context",
    "web_research",
    "shell_runtime",
    "local_file_io",
    "chat_file_io",
    "scheduler_admin",
    "comfy_image",
    "time_utils"
  ]
};
