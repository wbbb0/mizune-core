import type { SessionModeDefinition } from "./types.ts";
import { createOwnerPrivateGlobalProfileSetupPhase } from "./globalProfileSetup.ts";

export const assistantModeDefinition: SessionModeDefinition = {
  id: "assistant",
  title: "Assistant",
  description: "普通助手模式。使用全局 persona 作为人格底座，但不读取长期记忆、用户资料或模式专属资料。",
  allowedChatTypes: ["private", "group"],
  globalProfileAccess: {
    persona: true,
    modeProfile: null
  },
  defaultToolsetIds: [
    "chat_context",
    "web_research",
    "shell_runtime",
    "local_file_io",
    "chat_file_io",
    "scheduler_admin",
    "comfy_image",
    "time_utils"
  ],
  setupPhase: createOwnerPrivateGlobalProfileSetupPhase({
    persona: true,
    modeProfile: null
  })
};
