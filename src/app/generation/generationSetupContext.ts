import type { GlobalProfileReadinessStore } from "#identity/globalProfileReadinessStore.ts";
import type { SetupStateStore } from "#identity/setupStateStore.ts";
import type { SessionSetupAccess } from "#conversation/session/sessionCapabilities.ts";
import type { ScenarioHostStateStore } from "#modes/scenarioHost/stateStore.ts";
import { isScenarioStateInitialized } from "#modes/scenarioHost/types.ts";
import type { SetupCompletionSignal, SessionModeSetupContext } from "#modes/types.ts";
import type { SessionOperationMode } from "#conversation/session/sessionOperationMode.ts";

export async function resolveSessionModeSetupContext(
  modeId: string,
  sessionId: string,
  deps: {
    globalProfileReadinessStore: GlobalProfileReadinessStore;
    sessionManager: SessionSetupAccess & {
      getOperationMode(sessionId: string): SessionOperationMode;
    };
  },
  chatContext: {
    chatType: "private" | "group";
    relationship: string;
  }
): Promise<SessionModeSetupContext> {
  const readiness = await deps.globalProfileReadinessStore.get();

  return {
    personaReady: readiness.persona === "ready",
    modeProfileReady: modeId === "rp_assistant"
      ? readiness.rp === "ready"
      : modeId === "scenario_host"
        ? readiness.scenario === "ready"
        : true,
    operationMode: deps.sessionManager.getOperationMode(sessionId),
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
