import assert from "node:assert/strict";
import test from "node:test";
import type * as ManagedNeoForgeSmokeEntrypoint from "../../smoke/minecraft/managed-neoforge-smoke.ts";
import type { MinecraftRuntimeEvent } from "../../src/services/minecraft/actorTypes.ts";
import {
  DEFAULT_SMOKE_INSTRUCTION,
  MOVEMENT_CAPABILITY,
  assertMovementCapabilityManifest,
  consumeMovementEvents,
  drainEventCursor,
  parseMovementTerminalEvent,
  parseSmokeExpectedBehavior,
  parseSmokeInstruction,
  requireDecisionModelForBehavior,
  verifySucceededMovement
} from "../../smoke/minecraft/managed-neoforge-smoke-support.ts";

type SmokeEntrypointContract = typeof ManagedNeoForgeSmokeEntrypoint;
const smokeEntrypointTypechecks: SmokeEntrypointContract | null = null;
void smokeEntrypointTypechecks;

test("managed NeoForge smoke 严格解析 instruction、行为枚举与 movement 模型要求", () => {
  assert.equal(parseSmokeInstruction(undefined), DEFAULT_SMOKE_INSTRUCTION);
  assert.equal(parseSmokeInstruction("  看看周围，然后向东走几步  "), "看看周围，然后向东走几步");
  assert.equal(parseSmokeExpectedBehavior(undefined), "chat");
  assert.equal(parseSmokeExpectedBehavior(" movement "), "movement");
  assert.throws(() => parseSmokeExpectedBehavior("combat"), /只允许 chat 或 movement/u);
  assert.doesNotThrow(() => requireDecisionModelForBehavior("chat", null));
  assert.doesNotThrow(() => requireDecisionModelForBehavior("movement", "low-cost-model"));
  assert.throws(
    () => requireDecisionModelForBehavior("movement", null),
    /必须通过 MIZUNE_MC_SMOKE_DECISION_MODEL/u
  );
  assert.doesNotThrow(() => assertMovementCapabilityManifest({
    rpcMethods: ["behavior.start"],
    behaviorCapabilities: [MOVEMENT_CAPABILITY]
  }));
  assert.throws(() => assertMovementCapabilityManifest({
    rpcMethods: [],
    behaviorCapabilities: [MOVEMENT_CAPABILITY]
  }), /manifest 不完整/u);
  assert.throws(() => assertMovementCapabilityManifest({
    rpcMethods: ["behavior.start"],
    behaviorCapabilities: []
  }), /manifest 不完整/u);
});

test("managed NeoForge smoke 决策前分页排空超过 256 条的事件 backlog", async () => {
  const backlog = Array.from({ length: 600 }, (_, index) => event({ sequence: index + 1 }));
  const cursors: number[] = [];
  const cursor = await drainEventCursor(async afterSequence => {
    cursors.push(afterSequence);
    return backlog.filter(item => item.sequence > afterSequence).slice(0, 256);
  });
  assert.equal(cursor, 600);
  assert.deepEqual(cursors, [0, 256, 512]);
});

test("managed NeoForge smoke 只接受明确的高优先级 movement 终态事件", () => {
  assert.equal(parseMovementTerminalEvent(event({ priority: "low" })), null);
  assert.equal(parseMovementTerminalEvent(event({ capability: "minecraft.chat.send@1" })), null);
  assert.deepEqual(parseMovementTerminalEvent(event()), {
    capability: MOVEMENT_CAPABILITY,
    runId: "run-1",
    status: "succeeded",
    targetBlock: { x: 5, y: 64, z: -3 },
    reason: "arrived"
  });
  assert.deepEqual(parseMovementTerminalEvent(event({
    eventType: "behavior_cancelled",
    status: "cancelled",
    reason: "owner_cancelled"
  })), {
    capability: MOVEMENT_CAPABILITY,
    runId: "run-1",
    status: "cancelled",
    targetBlock: { x: 5, y: 64, z: -3 },
    reason: "owner_cancelled"
  });
  assert.throws(
    () => parseMovementTerminalEvent(event({ eventType: "behavior_cancelled", status: "succeeded" })),
    /类型与状态不一致/u
  );
});

test("managed NeoForge smoke 锁定唯一 movement run 并忽略旧或其他 run 的终态", () => {
  const oldOnly = consumeMovementEvents(
    { started: null, terminal: null },
    [
      event({ runId: "old-success" }),
      event({ runId: "old-failed", status: "failed", reason: "no_path" })
    ]
  );
  assert.deepEqual(oldOnly, { started: null, terminal: null });

  const samePage = consumeMovementEvents(oldOnly, [
    event({ eventType: "behavior_started", runId: "current" }),
    event({ runId: "other", status: "failed", reason: "stuck" }),
    event({ runId: "current" })
  ]);
  assert.equal(samePage.started?.runId, "current");
  assert.equal(samePage.terminal?.runId, "current");
  assert.equal(samePage.terminal?.status, "succeeded");

  assert.throws(() => consumeMovementEvents(
    { started: null, terminal: null },
    [
      event({ eventType: "behavior_started", runId: "first" }),
      event({ eventType: "behavior_started", runId: "second" })
    ]
  ), /多个新的 go_to 行为/u);
});

test("managed NeoForge smoke 用脚下 BlockPos 验证真实移动结果", () => {
  const terminal = parseMovementTerminalEvent(event());
  assert.ok(terminal);
  assert.deepEqual(verifySucceededMovement({
    terminal,
    startPosition: { x: 1.9, y: 64.99, z: -1.01 },
    finalPosition: { x: 5.25, y: 64, z: -2.1 }
  }), {
    capability: MOVEMENT_CAPABILITY,
    status: "succeeded",
    targetBlock: { x: 5, y: 64, z: -3 },
    startPosition: { x: 1.9, y: 64.99, z: -1.01 },
    finalPosition: { x: 5.25, y: 64, z: -2.1 },
    terminalReason: "arrived"
  });
  assert.throws(() => verifySucceededMovement({
    terminal,
    startPosition: { x: 5.1, y: 64, z: -2.9 },
    finalPosition: { x: 5.8, y: 64.9, z: -2.01 }
  }), /未发生变化/u);
  assert.throws(() => verifySucceededMovement({
    terminal,
    startPosition: { x: 1, y: 64, z: 1 },
    finalPosition: { x: 4.99, y: 64, z: -2.1 }
  }), /目标与最终双脚所在 BlockPos 不一致/u);
});

function event(overrides: {
  eventType?: "behavior_started" | "behavior_completed" | "behavior_cancelled";
  priority?: MinecraftRuntimeEvent["priority"];
  capability?: string;
  status?: string;
  reason?: string | null;
  runId?: string;
  sequence?: number;
  targetBlock?: { x: number; y: number; z: number };
} = {}): MinecraftRuntimeEvent {
  const eventType = overrides.eventType ?? "behavior_completed";
  return {
    protocolVersion: 2,
    eventId: "event-1",
    sequence: overrides.sequence ?? 1,
    actorId: "actor-1",
    eventType,
    priority: overrides.priority ?? (eventType === "behavior_started" ? "normal" : "high"),
    occurredAtMs: 1,
    actorRevision: 1,
    observationRevision: 1,
    payload: {
      behavior: {
        runId: overrides.runId ?? "run-1",
        capability: overrides.capability ?? MOVEMENT_CAPABILITY,
        status: overrides.status ?? (eventType === "behavior_started" ? "running" : "succeeded"),
        startedAtMs: 0,
        completedAtMs: 1,
        arguments: {
          targetBlock: overrides.targetBlock ?? { x: 5, y: 64, z: -3 },
          decisionReason: "测试"
        },
        reason: overrides.reason === undefined ? "arrived" : overrides.reason
      },
      result: null
    }
  };
}
