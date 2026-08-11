import type { SessionModeDefinition } from "../types.ts";
import { createOwnerPrivateProfileSetupPhase } from "../profileSetup.ts";

export const scenarioHostModeDefinition: SessionModeDefinition = {
  id: "scenario_host",
  title: "Scenario Host",
  description: "轻规则单人剧情主持模式。当前仅支持私聊。",
  allowedChatTypes: ["private"],
  profileAccess: {
    persona: true,
    modeProfile: "scenario"
  },
  toolsets: [
    "chat_context",
    "time_utils",
    "scenario_host_state"
  ].map((toolsetId) => ({
    toolsetId,
    defaultEnabled: true
  })),
  setupPhase: createOwnerPrivateProfileSetupPhase({
    persona: true,
    modeProfile: "scenario"
  })
};
