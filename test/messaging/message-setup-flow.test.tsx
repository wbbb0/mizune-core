import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureAutomaticSetupOperationMode,
  handlePostRouterSetupDecision
} from "../../src/app/messaging/messageSetupFlow.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createEmptyScenarioProfile } from "../../src/modes/scenarioHost/profileSchema.ts";
import { createInitialScenarioHostSessionState } from "../../src/modes/scenarioHost/types.ts";

function createContext(input: {
  modeId: "assistant" | "rp_assistant" | "scenario_host";
  relationship?: "owner" | "stranger";
  chatType?: "private" | "group";
  externalUserId?: string;
}) {
  return {
    session: {
      id: `session:${input.modeId}`,
      modeId: input.modeId,
      participantRef: { kind: "user", id: "owner" },
      title: null
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

function createScenarioState(input: {
  profile?: ReturnType<typeof createEmptyScenarioProfile>;
  completeRuntime?: boolean;
} = {}) {
  const state = createInitialScenarioHostSessionState({ playerUserId: "owner", playerDisplayName: "Owner" });
  return {
    ...state,
    profile: input.profile ?? createEmptyScenarioProfile(),
    player: {
      ...state.player,
      ...(input.completeRuntime ? {
        basicInfo: "旧城调查员。",
        characterDescription: "谨慎、善于观察，正在追查钟楼异象。",
        wornItems: [{ name: "旅行外套", wearPosition: "外套", description: "适合夜间行动" }],
        heldItems: [{ name: "旧提灯", description: "照亮雾中的道路", quantity: 1 }]
      } : {})
    }
  };
}

test("自动进入自然命名的角色配置阶段，不覆盖现有草稿", async () => {
  const config = createTestAppConfig();
  let operation: any = { kind: "normal" };
  const services = { config, sessionManager: { getOperationMode: () => operation, setOperationMode: (_id: string, value: unknown) => { operation = value; } } } as any;
  const context = createContext({ modeId: "rp_assistant" });
  await ensureAutomaticSetupOperationMode(services, context as any, () => {});
  assert.deepEqual(operation, { kind: "character_config", stage: "persona" });
  operation = { kind: "skill_config", skillId: "example" };
  await ensureAutomaticSetupOperationMode(services, context as any, () => {});
  assert.equal(operation.kind, "skill_config");
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
