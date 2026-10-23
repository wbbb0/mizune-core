import { createOwnerPrivateProfileSetupPhase } from "../profileSetup.ts";
import type { SessionModeDefinition } from "../types.ts";

export const statefulRpModeDefinition: SessionModeDefinition = {
  id: "stateful_rp",
  title: "沉浸状态 RP",
  description: "基于基础人格、社交设定和具身设定三层固定档案，维护每个会话独立的场景、衣物、身体与心理动态状态，并由代码结算周期的沉浸式角色扮演模式。",
  allowedChatTypes: ["private"],
  profileAccess: {
    persona: true,
    modeProfile: "rp"
  },
  toolsets: [
    { toolsetId: "stateful_rp_state", defaultEnabled: true },
    { toolsetId: "chat_context", defaultEnabled: true },
    { toolsetId: "memory_profile", defaultEnabled: true },
    { toolsetId: "conversation_navigation", defaultEnabled: true },
    { toolsetId: "image_generation", defaultEnabled: false },
    { toolsetId: "comfy_image", defaultEnabled: false },
    { toolsetId: "asset_io", defaultEnabled: false },
    { toolsetId: "scheduler_admin", defaultEnabled: false },
    { toolsetId: "debug_owner", defaultEnabled: false }
  ],
  setupPhase: createOwnerPrivateProfileSetupPhase({
    persona: true,
    modeProfile: "rp"
  })
};
