import type { SetupStateStore } from "#identity/setupStateStore.ts";
import type { SessionSetupAccess } from "#conversation/session/sessionCapabilities.ts";
import type { ScenarioHostStateStore } from "#modes/scenarioHost/stateStore.ts";
import { isScenarioStateInitialized } from "#modes/scenarioHost/types.ts";
import type { SetupCompletionSignal, SessionModeSetupContext } from "#modes/types.ts";

export async function resolveSessionModeSetupContext(
  modeId: string,
  sessionId: string,
  deps: {
    setupStore: SetupStateStore;
    scenarioHostStateStore: ScenarioHostStateStore;
    sessionManager: SessionSetupAccess;
  },
  chatContext: {
    chatType: "private" | "group";
    relationship: string;
  }
): Promise<SessionModeSetupContext> {
  const setupState = await deps.setupStore.get();
  const globalSetupReady = setupState.state === "ready";

  let sessionStateInitialized = false;
  if (modeId === "scenario_host") {
    const scenarioState = await deps.scenarioHostStateStore.get(sessionId);
    sessionStateInitialized = scenarioState != null && isScenarioStateInitialized(scenarioState);
  }

  return {
    globalSetupReady,
    sessionStateInitialized,
    setupConfirmedByUser: deps.sessionManager.isSetupConfirmed(sessionId),
    chatType: chatContext.chatType,
    relationship: chatContext.relationship
  };
}

export async function checkSetupCompletion(
  completionSignal: SetupCompletionSignal,
  sessionId: string,
  deps: {
    setupStore: SetupStateStore;
    scenarioHostStateStore: ScenarioHostStateStore;
    sessionManager: SessionSetupAccess;
  }
): Promise<boolean> {
  switch (completionSignal) {
    case "global_setup_ready": {
      const setupState = await deps.setupStore.get();
      return setupState.state === "ready";
    }
    case "session_state_initialized": {
      const scenarioState = await deps.scenarioHostStateStore.get(sessionId);
      return scenarioState != null && isScenarioStateInitialized(scenarioState);
    }
    case "user_command": {
      return deps.sessionManager.isSetupConfirmed(sessionId);
    }
  }
}
