import { createOwnerPrivateProfileSetupPhase } from "../profileSetup.ts";
import type { SessionModeDefinition } from "../types.ts";

export const statefulRpModeDefinition: SessionModeDefinition = {
  id: "stateful_rp",
  title: "沉浸状态 RP",
  description: "基于 Persona + RP 设定底座，结合身体感官、服饰久穿物理影响、表里心理反差、关系张力与后置时间自治结算的沉浸式角色扮演模式。",
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
