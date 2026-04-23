import type { SessionModeDefinition } from "../types.ts";
import { createOwnerPrivateGlobalProfileSetupPhase } from "../globalProfileSetup.ts";

export const scenarioHostModeDefinition: SessionModeDefinition = {
  id: "scenario_host",
  title: "Scenario Host",
  description: "轻规则单人剧情主持模式。当前仅支持私聊。",
  allowedChatTypes: ["private"],
  globalProfileAccess: {
    persona: true,
    modeProfile: "scenario"
  },
  defaultToolsetIds: [
    "chat_context",
    "time_utils",
    "scenario_host_state"
  ],
  setupPhase: createOwnerPrivateGlobalProfileSetupPhase({
    persona: true,
    modeProfile: "scenario"
  })
};
