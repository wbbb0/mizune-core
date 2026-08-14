import type {
  MinecraftBlockPos,
  MinecraftRuntimeEvent,
  MinecraftVec3
} from "../../src/services/minecraft/actorTypes.ts";

export const DEFAULT_SMOKE_INSTRUCTION =
  "登录服务器，看看周围环境，然后在游戏聊天里向服务器里的大家打个简短的招呼。";
export const MOVEMENT_CAPABILITY = "minecraft.movement.go_to@1";

export type SmokeExpectedBehavior = "chat" | "movement";

export interface MovementTerminal {
  capability: typeof MOVEMENT_CAPABILITY;
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
  targetBlock: MinecraftBlockPos;
  reason: string | null;
}

export interface MovementStarted {
  capability: typeof MOVEMENT_CAPABILITY;
  runId: string;
  status: "running";
  targetBlock: MinecraftBlockPos;
}

export interface MovementEventState {
  started: MovementStarted | null;
  terminal: MovementTerminal | null;
}

export const EVENT_PAGE_SIZE = 256;
export const MAX_EVENT_DRAIN_PAGES = 64;

export function parseSmokeInstruction(raw: string | undefined): string {
  return raw?.trim() || DEFAULT_SMOKE_INSTRUCTION;
}

export function parseSmokeExpectedBehavior(raw: string | undefined): SmokeExpectedBehavior {
  const normalized = raw?.trim() || "chat";
  if (normalized !== "chat" && normalized !== "movement") {
    throw new Error("MIZUNE_MC_SMOKE_EXPECT_BEHAVIOR 只允许 chat 或 movement");
  }
  return normalized;
}

export function requireDecisionModelForBehavior(
  expectedBehavior: SmokeExpectedBehavior,
  decisionModelRef: string | null
): void {
  if (expectedBehavior === "movement" && !decisionModelRef) {
    throw new Error("movement smoke 必须通过 MIZUNE_MC_SMOKE_DECISION_MODEL 指定决策模型");
  }
}

export function assertMovementCapabilityManifest(capabilities: {
  rpcMethods: readonly string[];
  behaviorCapabilities: readonly string[];
}): void {
  if (
    !capabilities.rpcMethods.includes("behavior.start")
    || !capabilities.behaviorCapabilities.includes(MOVEMENT_CAPABILITY)
  ) {
    throw new Error(
      `Runtime movement manifest 不完整：需要 behavior.start 与 ${MOVEMENT_CAPABILITY}`
    );
  }
}

export async function drainEventCursor(
  listEvents: (afterSequence: number) => Promise<readonly MinecraftRuntimeEvent[]>,
  initialCursor = 0
): Promise<number> {
  let cursor = initialCursor;
  for (let pageIndex = 0; pageIndex < MAX_EVENT_DRAIN_PAGES; pageIndex += 1) {
    const page = await listEvents(cursor);
    if (page.length > EVENT_PAGE_SIZE) {
      throw new Error(`events.list 单页超过 ${EVENT_PAGE_SIZE} 条`);
    }
    for (const event of page) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= cursor) {
        throw new Error(`events.list sequence 未严格递增：${event.sequence} <= ${cursor}`);
      }
      cursor = event.sequence;
    }
    if (page.length < EVENT_PAGE_SIZE) return cursor;
  }
  throw new Error(`决策前事件 backlog 超过 ${MAX_EVENT_DRAIN_PAGES * EVENT_PAGE_SIZE} 条，拒绝使用不稳定 cursor`);
}

export function consumeMovementEvents(
  state: MovementEventState,
  events: readonly MinecraftRuntimeEvent[]
): MovementEventState {
  let started = state.started;
  let terminal = state.terminal;
  for (const event of events) {
    const candidateStart = parseMovementStartedEvent(event);
    if (candidateStart) {
      if (started) {
        throw new Error(`检测到多个新的 go_to 行为：${started.runId}、${candidateStart.runId}`);
      }
      started = candidateStart;
    }
    const candidateTerminal = parseMovementTerminalEvent(event);
    if (!candidateTerminal || candidateTerminal.runId !== started?.runId) continue;
    if (!sameBlock(candidateTerminal.targetBlock, started.targetBlock)) {
      throw new Error("移动 start 与 terminal 的 targetBlock 不一致");
    }
    if (terminal) throw new Error(`移动行为 ${terminal.runId} 出现多个终态事件`);
    terminal = candidateTerminal;
  }
  return { started, terminal };
}

export function parseMovementStartedEvent(event: MinecraftRuntimeEvent): MovementStarted | null {
  if (event.eventType !== "behavior_started") return null;
  const behavior = record(event.payload.behavior);
  if (behavior?.capability !== MOVEMENT_CAPABILITY) return null;
  if (behavior.status !== "running") {
    throw new Error(`移动开始事件包含无效状态：${String(behavior.status)}`);
  }
  return {
    capability: MOVEMENT_CAPABILITY,
    runId: parseRunId(behavior.runId),
    status: "running",
    targetBlock: parseTargetBlock(behavior)
  };
}

export function parseMovementTerminalEvent(event: MinecraftRuntimeEvent): MovementTerminal | null {
  if (
    (event.eventType !== "behavior_completed" && event.eventType !== "behavior_cancelled")
    || (event.priority !== "high" && event.priority !== "critical")
  ) {
    return null;
  }
  const behavior = record(event.payload.behavior);
  if (behavior?.capability !== MOVEMENT_CAPABILITY) return null;
  const status = behavior.status;
  if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
    throw new Error(`移动终态事件包含无效状态：${String(status)}`);
  }
  if (
    (event.eventType === "behavior_cancelled") !== (status === "cancelled")
    || (event.eventType === "behavior_completed" && status === "cancelled")
  ) {
    throw new Error(`移动终态事件类型与状态不一致：${event.eventType}/${status}`);
  }
  const arguments_ = record(behavior.arguments);
  const targetBlock = parseBlockPos(arguments_?.targetBlock);
  const reason = behavior.reason;
  if (reason !== null && typeof reason !== "string") {
    throw new Error("移动终态 reason 不是字符串或 null");
  }
  return {
    capability: MOVEMENT_CAPABILITY,
    runId: parseRunId(behavior.runId),
    status,
    targetBlock,
    reason
  };
}

export function verifySucceededMovement(input: {
  terminal: MovementTerminal;
  startPosition: MinecraftVec3;
  finalPosition: MinecraftVec3;
}): {
  capability: typeof MOVEMENT_CAPABILITY;
  status: "succeeded";
  targetBlock: MinecraftBlockPos;
  startPosition: MinecraftVec3;
  finalPosition: MinecraftVec3;
  terminalReason: string | null;
} {
  const { terminal, startPosition, finalPosition } = input;
  if (terminal.status !== "succeeded") {
    throw new Error(`移动行为未成功：${terminal.status} (${terminal.reason ?? "无原因"})`);
  }
  const startBlock = footBlock(startPosition);
  const finalBlock = footBlock(finalPosition);
  if (sameBlock(startBlock, finalBlock)) {
    throw new Error("移动终态虽为 succeeded，但玩家双脚所在 BlockPos 未发生变化");
  }
  if (!sameBlock(finalBlock, terminal.targetBlock)) {
    throw new Error(
      `移动终态目标与最终双脚所在 BlockPos 不一致：目标 ${formatBlock(terminal.targetBlock)}，最终 ${formatBlock(finalBlock)}`
    );
  }
  return {
    capability: MOVEMENT_CAPABILITY,
    status: "succeeded",
    targetBlock: terminal.targetBlock,
    startPosition: copyVec3(startPosition),
    finalPosition: copyVec3(finalPosition),
    terminalReason: terminal.reason
  };
}

function parseTargetBlock(behavior: Record<string, unknown>): MinecraftBlockPos {
  const arguments_ = record(behavior.arguments);
  return parseBlockPos(arguments_?.targetBlock);
}

function parseBlockPos(value: unknown): MinecraftBlockPos {
  const block = record(value);
  if (!block || !isSignedInt32(block.x) || !isSignedInt32(block.y) || !isSignedInt32(block.z)) {
    throw new Error("移动终态缺少严格 signed32 targetBlock");
  }
  return { x: block.x, y: block.y, z: block.z };
}

function parseRunId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("movement behavior 缺少有界 runId");
  }
  return value;
}

function footBlock(position: MinecraftVec3): MinecraftBlockPos {
  if (![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new Error("玩家位置包含非有限数值");
  }
  const block = {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z)
  };
  if (!isSignedInt32(block.x) || !isSignedInt32(block.y) || !isSignedInt32(block.z)) {
    throw new Error("玩家脚下 BlockPos 超出 signed32 范围");
  }
  return block;
}

function isSignedInt32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= -(2 ** 31) && Number(value) <= 2 ** 31 - 1;
}

function sameBlock(left: MinecraftBlockPos, right: MinecraftBlockPos): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function formatBlock(block: MinecraftBlockPos): string {
  return `(${block.x}, ${block.y}, ${block.z})`;
}

function copyVec3(position: MinecraftVec3): MinecraftVec3 {
  return { x: position.x, y: position.y, z: position.z };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
