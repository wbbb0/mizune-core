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
    { toolsetId: "chat_context", defaultEnabled: true },
    { toolsetId: "time_utils", defaultEnabled: true },
    { toolsetId: "scenario_host_state", defaultEnabled: true },
    { toolsetId: "asset_io", defaultEnabled: false },
    { toolsetId: "speech_generation", defaultEnabled: false },
    { toolsetId: "native_decisions", defaultEnabled: false }
  ],
  setupPhase: createOwnerPrivateProfileSetupPhase({
    persona: true,
    modeProfile: "scenario"
  })
};
