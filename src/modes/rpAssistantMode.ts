import type { SessionModeDefinition } from "./types.ts";
import { createOwnerPrivateGlobalProfileSetupPhase } from "./globalProfileSetup.ts";

export const rpAssistantModeDefinition: SessionModeDefinition = {
  id: "rp_assistant",
  title: "RP Assistant",
  description: "当前默认模式。保留现有角色扮演 + 助手能力。",
  allowedChatTypes: ["private", "group"],
  globalProfileAccess: {
    persona: true,
    modeProfile: "rp"
  },
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
  setupPhase: createOwnerPrivateGlobalProfileSetupPhase({
    persona: true,
    modeProfile: "rp"
  })
};
