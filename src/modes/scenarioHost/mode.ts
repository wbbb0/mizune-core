import type { SessionModeDefinition } from "../types.ts";

export const scenarioHostModeDefinition: SessionModeDefinition = {
  id: "scenario_host",
  title: "Scenario Host",
  description: "轻规则单人剧情主持模式。当前仅支持私聊。",
  allowedChatTypes: ["private"],
  defaultToolsetIds: [
    "chat_context",
    "time_utils",
    "scenario_host_state"
  ],
  setupPhase: {
    needsSetup({ sessionStateInitialized }) {
      return !sessionStateInitialized;
    },
    promptMode: "chat_with_setup_injection",
    completionSignal: "session_state_initialized",
    onComplete: "none"
  }
};
