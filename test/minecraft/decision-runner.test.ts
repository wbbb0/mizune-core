import assert from "node:assert/strict";
import test from "node:test";
import type { LlmClient } from "../../src/llm/llmClient.ts";
import type {
  LlmGenerateParams,
  LlmGenerateResult,
  LlmToolCall,
  LlmUsage
} from "../../src/llm/provider/providerTypes.ts";
import type { MinecraftActorClient } from "../../src/services/minecraft/actorClient.ts";
import {
  MINECRAFT_DECISION_SYSTEM_PROMPT,
  MinecraftDecisionRunner
} from "../../src/services/minecraft/decisionRunner.ts";
import type {
  MinecraftActorSnapshot,
  MinecraftBehaviorCommand,
  MinecraftCancelBehaviorCommand,
  MinecraftCancelTaskCommand,
  MinecraftCommandResult,
  MinecraftObservationEnvelope,
  MinecraftObservationRequest,
  MinecraftRuntimeEvent,
  MinecraftSetAutonomyCommand,
  MinecraftTaskCommand
} from "../../src/services/minecraft/actorTypes.ts";
import pino from "pino";

type Generate = LlmClient["generate"];

class ScriptedDecisionLlm {
  params: LlmGenerateParams | null = null;

  constructor(private readonly script: (params: LlmGenerateParams) => Promise<void>) {}

  generate: Generate = async (params) => {
    this.params = params;
    await this.script(params);
    return llmResult();
  };
}

class FakeActorClient implements MinecraftActorClient {
  readonly calls: string[] = [];

  async getSnapshot(): Promise<MinecraftActorSnapshot> {
    this.calls.push("getSnapshot");
    return actorSnapshot();
  }

  async observe(request: MinecraftObservationRequest): Promise<MinecraftObservationEnvelope> {
    this.calls.push(`observe:${request.scope}`);
    return observation([]);
  }

  async startBehavior(_command: MinecraftBehaviorCommand): Promise<MinecraftCommandResult> {
    this.calls.push("startBehavior");
    return commandResult();
  }

  async cancelBehavior(_command: MinecraftCancelBehaviorCommand): Promise<MinecraftCommandResult> {
    this.calls.push("cancelBehavior");
    return commandResult();
  }

  async submitTask(_command: MinecraftTaskCommand): Promise<MinecraftCommandResult> {
    this.calls.push("submitTask");
    return commandResult();
  }

  async cancelTask(_command: MinecraftCancelTaskCommand): Promise<MinecraftCommandResult> {
    this.calls.push("cancelTask");
    return commandResult();
  }

  async setAutonomy(_command: MinecraftSetAutonomyCommand): Promise<MinecraftCommandResult> {
    this.calls.push("setAutonomy");
    return commandResult();
  }

  async listEvents(): Promise<MinecraftRuntimeEvent[]> {
    this.calls.push("listEvents");
    return [];
  }
}

test("decision runner uses exactly one stable system and two structured user messages", async () => {
  const actor = new FakeActorClient();
  const llm = new ScriptedDecisionLlm(async params => {
    await executeToolRound(params, [toolCall("read-1", "minecraft_get_snapshot", {})]);
    await executeToolRound(params, [toolCall("finish-1", "minecraft_finish_decision", {
      summary: "继续观察",
      persistentState: "目标：保护 Alice；当前没有活动任务",
      nextWakeHint: "出现敌对生物时唤起"
    })]);
  });
  const runner = new MinecraftDecisionRunner(llm, actor, pino({ level: "silent" }));

  const result = await runner.run(decisionInput());
  const params = llm.params;

  assert.ok(params);
  assert.equal(params.messages.length, 3);
  assert.deepEqual(params.messages.map(message => message.role), ["system", "user", "user"]);
  assert.equal(params.messages[0]?.content, MINECRAFT_DECISION_SYSTEM_PROMPT);
  assert.deepEqual(JSON.parse(String(params.messages[1]?.content)), {
    type: "minecraft_actor_persistent_state",
    actorId: "actor-1",
    currentGoal: "保护 Alice",
    persistentState: "此前在出生点待命"
  });
  assert.deepEqual(JSON.parse(String(params.messages[2]?.content)), {
    type: "minecraft_actor_wake_reason",
    wakeType: "idle_opportunity",
    summary: "已经空闲十秒",
    occurredAtMs: 20_000,
    details: { nearbyItems: 0 }
  });
  assert.equal(params.enableThinkingOverride, false);
  assert.equal(params.preferNativeNoThinkingChatEndpoint, true);
  assert.deepEqual(params.modelRefOverride, ["prod_deepseek.v4_flash", "prod_deepseek.v4_pro"]);
  assert.deepEqual(actor.calls, ["getSnapshot"]);
  assert.equal(result.completion.summary, "继续观察");
  assert.equal(result.completion.persistentState, "目标：保护 Alice；当前没有活动任务");
  assert.equal(result.toolCallCount, 2);
});

test("mixed read and control batch is rejected before any actor side effect", async () => {
  const actor = new FakeActorClient();
  const results: string[] = [];
  const llm = new ScriptedDecisionLlm(async params => {
    results.push(...await executeToolRound(params, [
      toolCall("read-mixed", "minecraft_get_snapshot", {}),
      toolCall("control-mixed", "minecraft_start_behavior", behaviorArgs())
    ]));
    await executeToolRound(params, [toolCall("finish-2", "minecraft_finish_decision", {
      summary: "批次被拒绝，未执行动作",
      persistentState: "保持原状态"
    })]);
  });
  const runner = new MinecraftDecisionRunner(llm, actor, pino({ level: "silent" }));

  await runner.run(decisionInput());

  assert.deepEqual(actor.calls, []);
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(JSON.parse(result).error, "invalid_tool_batch");
  }
});

test("single control call executes and autonomy tool is capability scoped", async () => {
  const actor = new FakeActorClient();
  const llm = new ScriptedDecisionLlm(async params => {
    await executeToolRound(params, [toolCall("control-1", "minecraft_start_behavior", behaviorArgs())]);
    await executeToolRound(params, [toolCall("finish-3", "minecraft_finish_decision", {
      summary: "开始前往目标",
      persistentState: "正在前往 x=8"
    })]);
  });
  const runner = new MinecraftDecisionRunner(llm, actor, pino({ level: "silent" }));

  await runner.run(decisionInput());

  assert.deepEqual(actor.calls, ["startBehavior"]);
  const toolNames = resolveTools(llm.params).map(tool => tool.function.name);
  assert.ok(!toolNames.includes("minecraft_set_autonomy"));
});

test("authorized decision loop receives autonomy policy tool", async () => {
  const actor = new FakeActorClient();
  const llm = new ScriptedDecisionLlm(async params => {
    await executeToolRound(params, [toolCall("finish-4", "minecraft_finish_decision", {
      summary: "无需修改",
      persistentState: "保持原状态"
    })]);
  });
  const runner = new MinecraftDecisionRunner(llm, actor, pino({ level: "silent" }));

  await runner.run({ ...decisionInput(), allowAutonomyPolicyChange: true });

  const toolNames = resolveTools(llm.params).map(tool => tool.function.name);
  assert.ok(toolNames.includes("minecraft_set_autonomy"));
});

test("plain final text cannot silently complete a decision", async () => {
  const runner = new MinecraftDecisionRunner(
    new ScriptedDecisionLlm(async () => {}),
    new FakeActorClient(),
    pino({ level: "silent" })
  );

  await assert.rejects(runner.run(decisionInput()), /未调用 minecraft_finish_decision/);
});

async function executeToolRound(params: LlmGenerateParams, calls: LlmToolCall[]): Promise<string[]> {
  await params.onAssistantToolCalls?.({ role: "assistant", content: "", tool_calls: calls });
  const executor = params.toolExecutor;
  assert.ok(executor);
  return Promise.all(calls.map(async call => {
    const result = await executor(call);
    return typeof result === "string" ? result : result.content;
  }));
}

function resolveTools(params: LlmGenerateParams | null) {
  assert.ok(params);
  return typeof params.tools === "function" ? params.tools() : (params.tools ?? []);
}

function toolCall(id: string, name: string, args: Record<string, unknown>): LlmToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) }
  };
}

function behaviorArgs() {
  return {
    kind: "go_to",
    position: { x: 8, y: 64, z: 0 },
    tolerance: 1,
    expectedActorRevision: 3,
    expectedObservationRevision: 7,
    idempotencyKey: "decision-control-1",
    decisionReason: "前往安全点"
  };
}

function decisionInput() {
  return {
    actorId: "actor-1",
    persistentState: "此前在出生点待命",
    currentGoal: "保护 Alice",
    wakeReason: {
      type: "idle_opportunity",
      summary: "已经空闲十秒",
      details: { nearbyItems: 0 },
      occurredAtMs: 20_000
    },
    modelRef: ["prod_deepseek.v4_flash", "prod_deepseek.v4_pro"],
    timeoutMs: 10_000
  };
}

function actorSnapshot(): MinecraftActorSnapshot {
  return {
    protocolVersion: 1,
    actorId: "actor-1",
    actorRevision: 3,
    observationRevision: 7,
    self: selfState(),
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

function observation(value: MinecraftObservationEnvelope["value"]): MinecraftObservationEnvelope {
  return {
    protocolVersion: 1,
    actorId: "actor-1",
    actorRevision: 3,
    observationRevision: 7,
    observedAtMs: 20_000,
    self: selfState(),
    value
  };
}

function commandResult(): MinecraftCommandResult {
  return {
    protocolVersion: 1,
    commandId: "command-1",
    idempotencyKey: "decision-control-1",
    ok: true,
    status: "accepted",
    reason: null,
    retryability: "none",
    actorRevision: 4,
    observationRevision: 7,
    value: {}
  };
}

function selfState() {
  return {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    connected: true
  };
}

function llmResult(): LlmGenerateResult {
  return {
    text: "done",
    reasoningContent: "",
    usage: usage(),
    providerCallUsages: []
  };
}

function usage(): LlmUsage {
  return {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cachedTokens: 80,
    reasoningTokens: 0,
    requestCount: 2,
    providerReported: true,
    modelRef: "prod_deepseek.v4_flash",
    model: "deepseek-v4-flash"
  };
}
