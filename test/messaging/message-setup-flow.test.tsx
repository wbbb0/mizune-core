import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureAutomaticSetupOperationMode,
  handlePostRouterSetupDecision
} from "../../src/app/messaging/messageSetupFlow.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createEmptyScenarioProfile } from "../../src/modes/scenarioHost/profileSchema.ts";

function createContext(input: {
  modeId: "assistant" | "rp_assistant" | "scenario_host";
  relationship?: "owner" | "stranger";
  chatType?: "private" | "group";
  externalUserId?: string;
}) {
  return {
    session: {
      id: `session:${input.modeId}`,
      modeId: input.modeId
    },
    enrichedMessage: {
      chatType: input.chatType ?? "private",
      userId: "owner",
      ...(input.externalUserId ? { externalUserId: input.externalUserId } : {})
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

test("assistant mode also enters persona_setup when global persona is not ready", async () => {
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
            rp: "ready",
            scenario: "ready"
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
    createContext({ modeId: "assistant" }) as any,
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
      selfPositioning: "keep me"
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
      selfPositioning: "keep me"
    }
  });
  assert.deepEqual(persistedReasons, []);
});

test("post-router setup block forwards external user id to immediate replies", async () => {
  const sendCalls: Array<Record<string, unknown>> = [];

  const handled = await handlePostRouterSetupDecision(
    {
      logger: {
        info() {}
      } as any,
      userIdentityStore: {
        async hasOwnerIdentity() {
          return true;
        }
      } as any
    },
    {
      ...createContext({
        modeId: "rp_assistant",
        relationship: "stranger",
        externalUserId: "2254600711"
      }),
      setupState: {
        state: "needs_persona"
      }
    } as any,
    async (params) => {
      sendCalls.push(params as Record<string, unknown>);
    }
  );

  assert.equal(handled, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0]?.userId, "owner");
  assert.equal(sendCalls[0]?.externalUserId, "2254600711");
  assert.match(String(sendCalls[0]?.text ?? ""), /当前实例仍在 OneBot 初始化阶段/);
});
