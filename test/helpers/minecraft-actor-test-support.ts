import type {
  MinecraftActorBindingState,
  MinecraftActorRecoveryState
} from "../../src/runtime/resources/resourceTypes.ts";

export function createTestMinecraftBinding(
  overrides: Partial<MinecraftActorBindingState> = {}
): MinecraftActorBindingState {
  const serverAddress = overrides.serverAddress ?? "127.0.0.1:25566";
  return {
    serverAddress,
    serverHost: "127.0.0.1",
    serverPort: 25566,
    serverKey: serverAddress,
    templateId: "test-runtime",
    templateFingerprint: "test-template-fingerprint",
    identityRef: "test-identity",
    backend: "simulation",
    desiredState: "open",
    provisionStatus: "ready",
    provisionPhase: "ready",
    failureCode: null,
    failureMessage: null,
    retryAtMs: null,
    attemptId: "test-attempt",
    ...overrides
  };
}

export function createTestMinecraftRecoveryState(
  overrides: Partial<MinecraftActorRecoveryState> = {}
): MinecraftActorRecoveryState {
  return {
    actorId: "actor-1",
    transportKind: "in_process",
    endpoint: "simulation:actor-1",
    protocolVersion: 1,
    persistentState: "在出生点待命",
    currentGoal: "巡逻",
    modelRefs: ["prod_deepseek.v4_flash"],
    allowAutonomyPolicyChange: false,
    allowProgramDeployment: false,
    lastEventSequence: 0,
    binding: createTestMinecraftBinding(),
    ...overrides
  };
}
