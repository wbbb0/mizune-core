import type { SessionModeDefinition } from "./types.ts";
import { createOwnerPrivateProfileSetupPhase } from "./profileSetup.ts";

export const assistantModeDefinition: SessionModeDefinition = {
  id: "assistant",
  title: "Assistant",
  description: "普通助手模式。使用全局 persona 作为人格底座，但不读取长期记忆、用户资料或模式专属资料。",
  allowedChatTypes: ["private", "group"],
  profileAccess: {
    persona: true,
    modeProfile: null
  },
  toolsets: [
    "chat_context",
    "web_research",
    "shell_runtime",
    "filesystem_io",
    "asset_io",
    "scheduler_admin",
    "comfy_image",
    "time_utils"
  ].map((toolsetId) => ({
    toolsetId,
    defaultEnabled: true
  })),
  setupPhase: createOwnerPrivateProfileSetupPhase({
    persona: true,
    modeProfile: null
  })
};
