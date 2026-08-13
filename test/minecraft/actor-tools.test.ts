import test from "node:test";
import assert from "node:assert/strict";
import { getBuiltinToolNames } from "../../src/llm/builtinTools.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";
import {
  minecraftActorToolDescriptors,
  minecraftActorToolHandlers
} from "../../src/llm/tools/runtime/minecraftActorTools.ts";
import type { LlmToolCall } from "../../src/llm/provider/providerTypes.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

const PUBLIC_TOOL_NAMES = [
  "minecraft_actor_list",
  "minecraft_actor_create",
  "minecraft_actor_request",
  "minecraft_actor_status",
  "minecraft_actor_interrupt",
  "minecraft_actor_close"
];

test("Minecraft Actor 主会话只暴露六个高层 owner 工具", () => {
  const enabled = minecraftConfig();
  const disabled = createTestAppConfig();
  const descriptorNames = minecraftActorToolDescriptors.map(item => item.definition.function.name);
  const ownerNames = getBuiltinToolNames("owner", null, enabled, { modelRef: ["main"] });

  assert.deepEqual(descriptorNames, PUBLIC_TOOL_NAMES);
  assert.deepEqual(
    ownerNames.filter(name => name.startsWith("minecraft_actor_")).sort(),
    [...PUBLIC_TOOL_NAMES].sort()
  );
  assert.ok(!getBuiltinToolNames("known", null, enabled, { modelRef: ["main"] }).includes("minecraft_actor_create"));
  assert.ok(!getBuiltinToolNames("owner", null, disabled, { modelRef: ["main"] }).includes("minecraft_actor_create"));
});

test("list 工具只查询当前 owner principal 的资源", async () => {
  const principals: string[] = [];
  const context = toolContext({
    async listOwned(ownerPrincipalId: string) {
      principals.push(ownerPrincipalId);
      return [];
    }
  });
  await minecraftActorToolHandlers.minecraft_actor_list!(
    toolCall("minecraft_actor_list", "list-1"),
    {},
    context
  );
  assert.deepEqual(principals, ["owner"]);
});

test("request 工具只持久委派并从 tool call 派生稳定幂等键", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let mailboxStarts = 0;
  const manager = {
    async request(_resourceId: string, input: Record<string, unknown>) {
      requests.push(input);
      return {
        request: { requestId: "request-1", status: "queued" },
        revision: 4,
        replayed: requests.length > 1
      };
    },
    async processMailbox() {
      mailboxStarts += 1;
      return null;
    }
  };
  const context = toolContext(manager);
  const call = toolCall("minecraft_actor_request", "call-1");
  const args = {
    resource_id: "res_mc_1",
    instruction: "去出生点找玩家，并在附近安全待命",
    constraints: "不要破坏方块",
    priority: "high"
  };

  const first = JSON.parse(String(await minecraftActorToolHandlers.minecraft_actor_request!(call, args, context)));
  const second = JSON.parse(String(await minecraftActorToolHandlers.minecraft_actor_request!(call, args, context)));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(first.accepted, true);
  assert.equal(first.request_id, "request-1");
  assert.equal(second.replayed, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.ownerPrincipalId, "owner");
  assert.equal(requests[0]?.ownerSessionId, "web:owner");
  assert.equal(requests[0]?.idempotencyKey, requests[1]?.idempotencyKey);
  assert.match(String(requests[0]?.idempotencyKey), /^tool:[0-9a-f]{64}$/u);
  assert.equal(mailboxStarts, 2);
  assert.equal("startBehavior" in manager, false);
});

test("status 只返回 manager 的安全读模型，interrupt/close 都携带 owner 主体", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const manager = {
    async status(_resourceId: string, ownerPrincipalId: string) {
      calls.push({ method: "status", input: ownerPrincipalId });
      return {
        resourceId: "res_mc_1",
        resourceStatus: "active",
        loopPhase: "idle",
        runtimeAvailable: false
      };
    },
    async interrupt(_resourceId: string, input: unknown) {
      calls.push({ method: "interrupt", input });
      return { interrupted: true, revision: 7 };
    },
    async close(_resourceId: string, _reason: string, input: unknown) {
      calls.push({ method: "close", input });
    }
  };
  const context = toolContext(manager);

  const status = JSON.parse(String(await minecraftActorToolHandlers.minecraft_actor_status!(
    toolCall("minecraft_actor_status", "status-1"),
    { resource_id: "res_mc_1" },
    context
  )));
  await minecraftActorToolHandlers.minecraft_actor_interrupt!(
    toolCall("minecraft_actor_interrupt", "interrupt-1"),
    { resource_id: "res_mc_1", reason: "先停下来" },
    context
  );
  await minecraftActorToolHandlers.minecraft_actor_close!(
    toolCall("minecraft_actor_close", "close-1"),
    { resource_id: "res_mc_1" },
    context
  );

  assert.equal(status.status.loopPhase, "idle");
  assert.deepEqual(calls, [
    { method: "status", input: "owner" },
    {
      method: "interrupt",
      input: {
        ownerPrincipalId: "owner",
        ownerSessionId: "web:owner",
        reason: "先停下来"
      }
    },
    { method: "close", input: { ownerPrincipalId: "owner" } }
  ]);
});

function minecraftConfig() {
  return createTestAppConfig({
    minecraft: {
      enabled: true,
      endpoints: {
        dev: {
          actorId: "actor-dev",
          socketPath: "../data/dev/minecraft-runtime/runtime.sock",
          modelRefs: ["ds_deepseek_v4_flash"]
        }
      }
    }
  });
}

function toolContext(manager: object): BuiltinToolContext {
  return {
    config: minecraftConfig(),
    relationship: "owner",
    replyDelivery: "web",
    lastMessage: { sessionId: "web:owner", userId: "owner", senderName: "Owner" },
    currentUser: null,
    minecraftActorManager: manager,
    minecraftActorProvisioning: { listEndpointIds: () => ["dev"] }
  } as unknown as BuiltinToolContext;
}

function toolCall(name: string, id: string): LlmToolCall {
  return { id, type: "function", function: { name, arguments: "{}" } };
}
