import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getBuiltinToolNames } from "../../src/llm/builtinTools.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";
import { minecraftActorToolHandlers } from "../../src/llm/tools/runtime/minecraftActorTools.ts";
import type { LlmToolCall } from "../../src/llm/provider/providerTypes.ts";
import type {
  MinecraftBehaviorCommand,
  MinecraftProgramDocument
} from "../../src/services/minecraft/actorTypes.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("Minecraft Actor 工具只在功能启用的 owner 会话中可见", () => {
  const enabled = minecraftConfig();
  const disabled = createTestAppConfig();

  assert.ok(getBuiltinToolNames("owner", null, enabled, { modelRef: ["main"] }).includes("minecraft_actor_create"));
  assert.ok(!getBuiltinToolNames("known", null, enabled, { modelRef: ["main"] }).includes("minecraft_actor_create"));
  assert.ok(!getBuiltinToolNames("owner", null, disabled, { modelRef: ["main"] }).includes("minecraft_actor_create"));
});

test("行为工具从 tool call 派生稳定幂等键且不接受模型 revision", async () => {
  const commands: MinecraftBehaviorCommand[] = [];
  const manager = {
    async probe() { return snapshot(); },
    async startBehavior(_resourceId: string, command: MinecraftBehaviorCommand) {
      commands.push(command);
      return commandResult(command.idempotencyKey);
    }
  };
  const context = toolContext(manager);
  const call = toolCall("minecraft_actor_start_behavior", "call-1");
  const args = {
    resource_id: "res_mc_1",
    kind: "go_to",
    position: { x: 4, y: 64, z: 8 },
    tolerance: 1,
    reason: "前往集合点",
    expectedActorRevision: 999
  };

  // Provider schema 会拒绝额外字段；直接 handler 调用也不会读取模型提供的 revision。
  await minecraftActorToolHandlers.minecraft_actor_start_behavior!(call, args, context);
  await minecraftActorToolHandlers.minecraft_actor_start_behavior!(call, args, context);

  assert.equal(commands.length, 2);
  assert.equal(commands[0]?.expectedActorRevision, 3);
  assert.equal(commands[0]?.expectedObservationRevision, 7);
  assert.equal(commands[0]?.idempotencyKey, commands[1]?.idempotencyKey);
  assert.match(commands[0]?.idempotencyKey ?? "", /^tool:[0-9a-f]{64}$/u);
});

test("程序工具在父项目生成规范文档、源码哈希和模型来源", async () => {
  let captured: MinecraftProgramDocument | null = null;
  const manager = {
    async probe() { return snapshot(); },
    async get() {
      return {
        minecraftActor: {
          actorId: "actor-dev",
          transportKind: "unix_socket",
          endpoint: "/run/mizune/runtime.sock",
          protocolVersion: 1,
          persistentState: "待命",
          currentGoal: null,
          modelRefs: ["ds_deepseek_v4_flash"],
          allowAutonomyPolicyChange: true,
          allowProgramDeployment: true,
          lastEventSequence: 0
        }
      };
    },
    async validateProgram(_resourceId: string, document: MinecraftProgramDocument) {
      captured = document;
      return {
        protocolVersion: 1 as const,
        ok: true,
        draft: { draftId: "draft-1", validatedAtMs: 1, program: document },
        diagnostics: []
      };
    }
  };
  const context = toolContext(manager);
  const source = "async def main(ctx):\n    return\n";
  const raw = await minecraftActorToolHandlers.minecraft_actor_validate_program!(
    toolCall("minecraft_actor_validate_program", "program-call-1"),
    {
      resource_id: "res_mc_1",
      program_id: "idle-v1",
      program_version: 1,
      source,
      required_capabilities: [],
      summary: "空闲行为"
    },
    context
  );

  assert.equal(JSON.parse(String(raw)).ok, true);
  const document = captured as MinecraftProgramDocument | null;
  assert.ok(document);
  assert.equal(document.expectedActorRevision, 3);
  assert.equal(document.sourceHash, `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`);
  assert.equal(document.metadata.modelRef, "ds_deepseek_v4_flash");
  assert.equal(document.metadata.decisionId, "program-call-1");
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

function snapshot() {
  return {
    protocolVersion: 1 as const,
    actorId: "actor-dev",
    actorRevision: 3,
    observationRevision: 7,
    self: {
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      food: 20,
      connected: true
    },
    activeBehavior: null,
    actionLease: null,
    activeTask: null,
    queuedTaskCount: 0,
    autonomyPolicy: {
      enabled: false,
      idleDelayMs: 10_000,
      collectItems: true,
      explore: true,
      combatHostiles: false,
      exploreRadius: 12,
      combatStopHealth: 8
    }
  };
}

function commandResult(idempotencyKey: string) {
  return {
    protocolVersion: 1 as const,
    commandId: "command-1",
    idempotencyKey,
    ok: true,
    status: "accepted" as const,
    reason: null,
    retryability: "none" as const,
    actorRevision: 4,
    observationRevision: 7,
    value: {}
  };
}
