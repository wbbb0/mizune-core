import type { SessionModeDefinition } from "./types.ts";
import { createOwnerPrivateProfileSetupPhase } from "./profileSetup.ts";

export const rpAssistantModeDefinition: SessionModeDefinition = {
  id: "rp_assistant",
  title: "RP Assistant",
  description: "当前默认模式。保留现有角色扮演 + 助手能力。",
  allowedChatTypes: ["private", "group"],
  profileAccess: {
    persona: true,
    modeProfile: "rp"
  },
  toolsets: [
    "chat_context",
    "memory_profile",
    "conversation_navigation",
    "chat_delegation",
    "web_research",
    "shell_runtime",
    "filesystem_io",
    "asset_io",
    "social_admin",
    "scheduler_admin",
    "comfy_image",
    "time_utils",
    "debug_owner"
  ].map((toolsetId) => ({
    toolsetId,
    defaultEnabled: true
  })),
  setupPhase: createOwnerPrivateProfileSetupPhase({
    persona: true,
    modeProfile: "rp"
  })
};
