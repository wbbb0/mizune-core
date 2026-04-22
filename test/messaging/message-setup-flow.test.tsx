import test from "node:test";
import assert from "node:assert/strict";
import { ensureAutomaticSetupOperationMode } from "../../src/app/messaging/messageSetupFlow.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createEmptyScenarioProfile } from "../../src/modes/scenarioHost/profileSchema.ts";

function createContext(input: {
  modeId: "rp_assistant" | "scenario_host";
  relationship?: "owner" | "stranger";
  chatType?: "private" | "group";
}) {
  return {
    session: {
      id: `session:${input.modeId}`,
      modeId: input.modeId
    },
    enrichedMessage: {
      chatType: input.chatType ?? "private"
    },
    user: {
      relationship: input.relationship ?? "owner"
    }
  };
}

test("automatic setup enters persona_setup before mode setup", async () => {
  let latestOperationMode: unknown = { kind: "normal" };
  const persistedReasons: string[] = [];

  await ensureAutomaticSetupOperationMode(
    {
      sessionManager: {
        getOperationMode() {
          return latestOperationMode;
        },
        setOperationMode(_sessionId: string, operationMode: unknown) {
          latestOperationMode = operationMode;
          return operationMode;
        }
      } as any,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "uninitialized",
            rp: "uninitialized",
            scenario: "uninitialized"
          };
        }
      } as any,
      personaStore: {
        createEmpty() {
          return createEmptyPersona();
        }
      } as any,
      rpProfileStore: {
        createEmpty() {
          return createEmptyRpProfile();
        }
      } as any,
      scenarioProfileStore: {
        createEmpty() {
          return createEmptyScenarioProfile();
        }
      } as any
    },
    createContext({ modeId: "rp_assistant" }) as any,
    (_sessionId: string, reason: string) => {
      persistedReasons.push(reason);
    }
  );

  assert.deepEqual(latestOperationMode, {
    kind: "persona_setup",
    draft: createEmptyPersona()
  });
  assert.deepEqual(persistedReasons, ["persona_setup_mode_auto_entered"]);
});

test("automatic setup enters rp mode draft after persona is ready", async () => {
  let latestOperationMode: unknown = { kind: "normal" };
  const persistedReasons: string[] = [];

  await ensureAutomaticSetupOperationMode(
    {
      sessionManager: {
        getOperationMode() {
          return latestOperationMode;
        },
        setOperationMode(_sessionId: string, operationMode: unknown) {
          latestOperationMode = operationMode;
          return operationMode;
        }
      } as any,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "uninitialized",
            scenario: "uninitialized"
          };
        }
      } as any,
      personaStore: {
        createEmpty() {
          return createEmptyPersona();
        }
      } as any,
      rpProfileStore: {
        createEmpty() {
          return createEmptyRpProfile();
        }
      } as any,
      scenarioProfileStore: {
        createEmpty() {
          return createEmptyScenarioProfile();
        }
      } as any
    },
    createContext({ modeId: "rp_assistant" }) as any,
    (_sessionId: string, reason: string) => {
      persistedReasons.push(reason);
    }
  );

  assert.deepEqual(latestOperationMode, {
    kind: "mode_setup",
    modeId: "rp_assistant",
    draft: createEmptyRpProfile()
  });
  assert.deepEqual(persistedReasons, ["rp_setup_mode_auto_entered"]);
});

test("automatic setup enters scenario mode draft after persona is ready", async () => {
  let latestOperationMode: unknown = { kind: "normal" };
  const persistedReasons: string[] = [];

  await ensureAutomaticSetupOperationMode(
    {
      sessionManager: {
        getOperationMode() {
          return latestOperationMode;
        },
        setOperationMode(_sessionId: string, operationMode: unknown) {
          latestOperationMode = operationMode;
          return operationMode;
        }
      } as any,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "ready",
            scenario: "uninitialized"
          };
        }
      } as any,
      personaStore: {
        createEmpty() {
          return createEmptyPersona();
        }
      } as any,
      rpProfileStore: {
        createEmpty() {
          return createEmptyRpProfile();
        }
      } as any,
      scenarioProfileStore: {
        createEmpty() {
          return createEmptyScenarioProfile();
        }
      } as any
    },
    createContext({ modeId: "scenario_host" }) as any,
    (_sessionId: string, reason: string) => {
      persistedReasons.push(reason);
    }
  );

  assert.deepEqual(latestOperationMode, {
    kind: "mode_setup",
    modeId: "scenario_host",
    draft: createEmptyScenarioProfile()
  });
  assert.deepEqual(persistedReasons, ["scenario_setup_mode_auto_entered"]);
});

test("automatic setup does not override an existing draft mode", async () => {
  const latestOperationMode = {
    kind: "mode_config",
    modeId: "rp_assistant",
    draft: {
      ...createEmptyRpProfile(),
      premise: "keep me"
    }
  };
  const persistedReasons: string[] = [];

  await ensureAutomaticSetupOperationMode(
    {
      sessionManager: {
        getOperationMode() {
          return latestOperationMode;
        },
        setOperationMode() {
          throw new Error("should not override existing operation mode");
        }
      } as any,
      globalProfileReadinessStore: {
        async get() {
          return {
            persona: "ready",
            rp: "uninitialized",
            scenario: "uninitialized"
          };
        }
      } as any,
      personaStore: {
        createEmpty() {
          return createEmptyPersona();
        }
      } as any,
      rpProfileStore: {
        createEmpty() {
          return createEmptyRpProfile();
        }
      } as any,
      scenarioProfileStore: {
        createEmpty() {
          return createEmptyScenarioProfile();
        }
      } as any
    },
    createContext({ modeId: "rp_assistant" }) as any,
    (_sessionId: string, reason: string) => {
      persistedReasons.push(reason);
    }
  );

  assert.deepEqual(latestOperationMode, {
    kind: "mode_config",
    modeId: "rp_assistant",
    draft: {
      ...createEmptyRpProfile(),
      premise: "keep me"
    }
  });
  assert.deepEqual(persistedReasons, []);
});
