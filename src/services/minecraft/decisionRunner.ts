import { createHash } from "node:crypto";
import type { LlmClient } from "#llm/llmClient.ts";
import type {
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
  LlmToolExecutionResult,
  LlmUsage
} from "#llm/provider/providerTypes.ts";
import { parseToolArguments } from "#llm/shared/toolArgs.ts";
import type { Logger } from "pino";
import { z } from "zod";
import type { MinecraftActorClient } from "./actorClient.ts";
import type {
  JsonValue,
  MinecraftActivateProgramCommand,
  MinecraftAutonomyPolicy,
  MinecraftBehaviorCommand,
  MinecraftObservationRequest,
  MinecraftProgramDocument,
  MinecraftProgramValidationResult,
  MinecraftTaskCommand
} from "./actorTypes.ts";

export const MINECRAFT_DECISION_SYSTEM_PROMPT = `你是 Mizune 的 Minecraft Actor 决策器。你只负责上层目标选择、异常处理和任务规划；移动、交互、战斗、聊天等执行由确定性状态机完成。

规则：
1. 先按需读取状态，再提交一个明确的行为或任务。只读工具可在同一轮并行；任何控制工具必须独占一轮，不能与读取、其他控制或结束工具同批调用。
2. 所有对象只能使用读取工具返回的不透明 ref；所有控制都必须携带最新 actor_revision、observation_revision 和新的 idempotency_key。
3. 普通文本没有控制效果。完成本次决策时必须调用 minecraft_finish_decision，返回简短决策摘要和完整的更新后持久状态文本。
4. 不确定、引用过期或 revision 冲突时重新读取；不要猜测实时状态。不要逐 tick 控制，优先提交参数化高层行为或任务。
5. 每次唤起最多成功提交一个控制；提交成功后只允许读取结果或结束本次决策，不能再启动第二个行为、任务或程序版本。
6. 程序修改必须先校验草稿，再在后续独占轮次原子激活；静态校验不等于安全隔离，也不能扩张未授权 capability。
7. 不得尝试执行任意 Shell、Java、网络或未声明能力。`;

const READ_TOOL_NAMES = new Set([
  "minecraft_get_snapshot",
  "minecraft_observe",
  "minecraft_get_active_program"
]);
const CONTROL_TOOL_NAMES = new Set([
  "minecraft_start_behavior",
  "minecraft_submit_task",
  "minecraft_cancel_behavior",
  "minecraft_cancel_task",
  "minecraft_set_autonomy",
  "minecraft_activate_program"
]);
const TERMINAL_TOOL_NAME = "minecraft_finish_decision";

const observationRequestSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("self") }).strict(),
  z.object({ scope: z.literal("environment") }).strict(),
  z.object({ scope: z.literal("inventory") }).strict(),
  z.object({
    scope: z.literal("entities"),
    kind: z.enum(["player", "hostile", "passive", "item"]).optional(),
    radius: z.number().finite().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(128).optional()
  }).strict(),
  z.object({ scope: z.literal("player"), playerUuid: z.string().min(1) }).strict(),
  z.object({
    scope: z.literal("chat"),
    afterMessageId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional()
  }).strict(),
  z.object({
    scope: z.literal("tasks"),
    includeCompleted: z.boolean().optional(),
    limit: z.number().int().min(1).max(128).optional()
  }).strict()
]);

const revisionFields = {
  expectedActorRevision: z.number().int().nonnegative(),
  expectedObservationRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(128),
  decisionReason: z.string().min(1).max(300)
} as const;

const vec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite()
}).strict();

const behaviorCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("go_to"),
    position: vec3Schema,
    tolerance: z.number().finite().min(0.25).max(8),
    ...revisionFields
  }).strict(),
  z.object({
    kind: z.literal("follow_and_assist"),
    targetRef: z.string().min(1),
    followDistance: z.number().finite().min(2).max(6),
    lostTargetWaitSeconds: z.number().int().min(3).max(30),
    ...revisionFields
  }).strict(),
  z.object({
    kind: z.literal("interact_entity"),
    targetRef: z.string().min(1),
    interaction: z.enum(["use", "mount", "feed"]),
    ...revisionFields
  }).strict(),
  z.object({ kind: z.literal("collect_item"), targetRef: z.string().min(1), ...revisionFields }).strict(),
  z.object({
    kind: z.literal("chat"),
    text: z.string().min(1).max(256),
    channel: z.enum(["global", "team"]),
    ...revisionFields
  }).strict(),
  z.object({
    kind: z.literal("combat"),
    targetRef: z.string().min(1),
    stopHealth: z.number().finite().min(2).max(18),
    ...revisionFields
  }).strict()
]);

const taskCommandSchema = z.object({
  kind: z.enum(["go_to", "collect_item", "interact_entity", "chat", "combat"]),
  arguments: z.record(z.string(), z.unknown()),
  priority: z.enum(["low", "normal", "high"]),
  ...revisionFields
}).strict();

const cancelBehaviorSchema = z.object({
  expectedActorRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(128),
  reason: z.string().min(1).max(300)
}).strict();

const cancelTaskSchema = cancelBehaviorSchema.extend({ taskId: z.string().min(1) }).strict();

const autonomyPolicySchema = z.object({
  enabled: z.boolean(),
  idleDelayMs: z.number().int().min(1_000).max(300_000),
  collectItems: z.boolean(),
  explore: z.boolean(),
  combatHostiles: z.boolean(),
  exploreRadius: z.number().finite().min(4).max(64),
  combatStopHealth: z.number().finite().min(2).max(18)
}).strict();

const setAutonomySchema = z.object({
  policy: autonomyPolicySchema,
  expectedActorRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(128)
}).strict();

const validateProgramSchema = z.object({
  programId: z.string().min(1).max(128),
  programVersion: z.number().int().positive(),
  expectedActorRevision: z.number().int().nonnegative(),
  source: z.string().min(1).max(100_000),
  requiredCapabilities: z.array(z.string().min(1)).max(128).refine(
    values => new Set(values).size === values.length,
    "requiredCapabilities 不能重复"
  ),
  summary: z.string().max(4_000).optional()
}).strict();

const activateProgramSchema = z.object({
  draftId: z.string().min(1),
  expectedActorRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(128),
  decisionReason: z.string().min(1).max(300)
}).strict();

const finishDecisionSchema = z.object({
  summary: z.string().min(1).max(500),
  persistentState: z.string().max(20_000),
  currentGoal: z.string().max(500).nullable().optional(),
  nextWakeHint: z.string().max(500).optional()
}).strict();

export interface MinecraftDecisionWakeReason {
  type: string;
  summary: string;
  details?: JsonValue;
  occurredAtMs: number;
}

export interface MinecraftDecisionInput {
  actorId: string;
  persistentState: string;
  currentGoal: string | null;
  wakeReason: MinecraftDecisionWakeReason;
  modelRef: string | string[];
  timeoutMs?: number;
  allowAutonomyPolicyChange?: boolean;
  allowProgramDeployment?: boolean;
  abortSignal?: AbortSignal;
}

export interface MinecraftDecisionCompletion {
  summary: string;
  persistentState: string;
  currentGoal: string | null;
  nextWakeHint: string | null;
}

export interface MinecraftDecisionResult {
  completion: MinecraftDecisionCompletion;
  usage: LlmUsage;
  durationMs: number;
  toolCallCount: number;
}

type MinecraftDecisionLlm = Pick<LlmClient, "generate">;

export class MinecraftDecisionRunner {
  constructor(
    private readonly llm: MinecraftDecisionLlm,
    private readonly actor: MinecraftActorClient,
    private readonly logger: Logger
  ) {}

  async run(input: MinecraftDecisionInput): Promise<MinecraftDecisionResult> {
    const startedAtMs = Date.now();
    const messages = buildDecisionMessages(input);
    const tools = buildDecisionTools({
      includeAutonomy: input.allowAutonomyPolicyChange === true,
      includeProgramDeployment: input.allowProgramDeployment === true
    });
    const rejectedCallIds = new Set<string>();
    let completion: MinecraftDecisionCompletion | null = null;
    let committedControlTool: string | null = null;
    let toolCallCount = 0;
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? 10_000);
    const abortSignal = input.abortSignal
      ? AbortSignal.any([input.abortSignal, timeoutSignal])
      : timeoutSignal;

    const result = await this.llm.generate({
      messages,
      tools,
      modelRefOverride: input.modelRef,
      enableThinkingOverride: false,
      preferNativeNoThinkingChatEndpoint: true,
      timeoutMsOverride: input.timeoutMs ?? 10_000,
      abortSignal,
      toolConcurrency: {
        maxConcurrency: 4,
        analyze: toolCall => READ_TOOL_NAMES.has(toolCall.function.name)
          ? { kind: "parallel", reads: ["minecraft_actor"], writes: [] }
          : { kind: "barrier", reads: [], writes: ["minecraft_actor"] }
      },
      onAssistantToolCalls: (message) => {
        const calls = message.tool_calls ?? [];
        toolCallCount += calls.length;
        if (!isLegalToolBatch(calls)) {
          for (const call of calls) {
            rejectedCallIds.add(call.id);
          }
        }
      },
      toolExecutor: async (toolCall) => {
        if (rejectedCallIds.has(toolCall.id)) {
          return jsonResult({
            error: "invalid_tool_batch",
            message: "控制或结束工具必须独占一轮；本批调用未执行任何副作用。"
          });
        }
        if (CONTROL_TOOL_NAMES.has(toolCall.function.name) && committedControlTool !== null) {
          return jsonResult({
            error: "decision_control_already_committed",
            committedTool: committedControlTool,
            message: "本次唤起已经成功提交一个控制；请结束决策并等待下一次唤起。"
          });
        }
        const args = parseToolArguments(toolCall.function.arguments, this.logger, {
          toolName: toolCall.function.name,
          toolCallId: toolCall.id
        });
        try {
          const executed = await this.executeTool(
            toolCall.function.name,
            args,
            abortSignal,
            input.allowAutonomyPolicyChange === true,
            input.allowProgramDeployment === true,
            input.currentGoal
          );
          if (executed.committed) {
            committedControlTool = toolCall.function.name;
          }
          if (executed.completion) {
            completion = executed.completion;
          }
          return executed.result;
        } catch (error) {
          if (isAbortError(error, abortSignal)) {
            throw error;
          }
          return jsonResult({
            error: "tool_execution_failed",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });

    if (completion === null) {
      throw new Error("Minecraft 决策循环未调用 minecraft_finish_decision");
    }
    return {
      completion,
      usage: result.usage,
      durationMs: Date.now() - startedAtMs,
      toolCallCount
    };
  }

  private async executeTool(
    name: string,
    rawArgs: unknown,
    signal: AbortSignal,
    allowAutonomyPolicyChange: boolean,
    allowProgramDeployment: boolean,
    existingGoal: string | null
  ): Promise<{
    result: string | LlmToolExecutionResult;
    completion?: MinecraftDecisionCompletion;
    committed?: boolean;
  }> {
    switch (name) {
      case "minecraft_get_snapshot":
        return { result: jsonResult(await this.actor.getSnapshot(signal)) };
      case "minecraft_observe": {
        const request = observationRequestSchema.parse(rawArgs) as MinecraftObservationRequest;
        return { result: jsonResult(await this.actor.observe(request, signal)) };
      }
      case "minecraft_get_active_program":
        return { result: jsonResult(await this.actor.getActiveProgram(signal)) };
      case "minecraft_start_behavior": {
        const command = behaviorCommandSchema.parse(rawArgs) as MinecraftBehaviorCommand;
        return commandExecutionResult(await this.actor.startBehavior(command, signal));
      }
      case "minecraft_submit_task": {
        const command = taskCommandSchema.parse(rawArgs) as MinecraftTaskCommand;
        return commandExecutionResult(await this.actor.submitTask(command, signal));
      }
      case "minecraft_cancel_behavior":
        return commandExecutionResult(await this.actor.cancelBehavior(cancelBehaviorSchema.parse(rawArgs), signal));
      case "minecraft_cancel_task":
        return commandExecutionResult(await this.actor.cancelTask(cancelTaskSchema.parse(rawArgs), signal));
      case "minecraft_set_autonomy": {
        if (!allowAutonomyPolicyChange) {
          return { result: jsonResult({ error: "autonomy_policy_change_not_allowed" }) };
        }
        const command = setAutonomySchema.parse(rawArgs) as {
          policy: MinecraftAutonomyPolicy;
          expectedActorRevision: number;
          idempotencyKey: string;
        };
        return commandExecutionResult(await this.actor.setAutonomy(command, signal));
      }
      case "minecraft_validate_program": {
        if (!allowProgramDeployment) {
          return { result: jsonResult({ error: "program_deployment_not_allowed" }) };
        }
        const input = validateProgramSchema.parse(rawArgs);
        const document: MinecraftProgramDocument = {
          protocolVersion: 1,
          programId: input.programId,
          programVersion: input.programVersion,
          expectedActorRevision: input.expectedActorRevision,
          language: "python",
          apiVersion: "mizune.mc.v1",
          entrypoint: "main",
          source: input.source,
          sourceHash: `sha256:${createHash("sha256").update(input.source, "utf8").digest("hex")}`,
          requiredCapabilities: input.requiredCapabilities,
          metadata: input.summary === undefined ? {} : { summary: input.summary }
        };
        const validation: MinecraftProgramValidationResult = await this.actor.validateProgram(document, signal);
        return { result: jsonResult(validation) };
      }
      case "minecraft_activate_program": {
        if (!allowProgramDeployment) {
          return { result: jsonResult({ error: "program_deployment_not_allowed" }) };
        }
        const command = activateProgramSchema.parse(rawArgs) as MinecraftActivateProgramCommand;
        return commandExecutionResult(await this.actor.activateProgram(command, signal));
      }
      case TERMINAL_TOOL_NAME: {
        const finished = finishDecisionSchema.parse(rawArgs);
        const decision: MinecraftDecisionCompletion = {
          summary: finished.summary,
          persistentState: finished.persistentState,
          currentGoal: finished.currentGoal === undefined ? existingGoal : finished.currentGoal,
          nextWakeHint: finished.nextWakeHint ?? null
        };
        return {
          completion: decision,
          result: {
            content: jsonResult({ ok: true, decisionAccepted: true }),
            terminalResponse: { text: finished.summary }
          }
        };
      }
      default:
        return { result: jsonResult({ error: "unknown_minecraft_decision_tool", tool: name }) };
    }
  }
}

function buildDecisionMessages(input: MinecraftDecisionInput): LlmMessage[] {
  return [
    { role: "system", content: MINECRAFT_DECISION_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        type: "minecraft_actor_persistent_state",
        actorId: input.actorId,
        currentGoal: input.currentGoal,
        persistentState: input.persistentState
      })
    },
    {
      role: "user",
      content: JSON.stringify({
        type: "minecraft_actor_wake_reason",
        wakeType: input.wakeReason.type,
        summary: input.wakeReason.summary,
        occurredAtMs: input.wakeReason.occurredAtMs,
        ...(input.wakeReason.details !== undefined ? { details: input.wakeReason.details } : {})
      })
    }
  ];
}

function isLegalToolBatch(calls: LlmToolCall[]): boolean {
  if (calls.length <= 1) {
    return true;
  }
  return calls.every(call => READ_TOOL_NAMES.has(call.function.name));
}

function buildDecisionTools(options: {
  includeAutonomy: boolean;
  includeProgramDeployment: boolean;
}): LlmToolDefinition[] {
  const tools: LlmToolDefinition[] = [
    tool("minecraft_get_snapshot", "读取 Actor revision、当前行为、任务、lease、自身状态和自治策略。", {}),
    tool("minecraft_observe", "按范围读取同一 observation revision 下的结构化游戏状态。", {
      scope: { type: "string", enum: ["self", "environment", "inventory", "entities", "player", "chat", "tasks"] },
      kind: { type: "string", enum: ["player", "hostile", "passive", "item"] },
      radius: { type: "number", minimum: 1, maximum: 128 },
      limit: { type: "integer", minimum: 1, maximum: 128 },
      playerUuid: { type: "string" },
      afterMessageId: { type: "string" },
      includeCompleted: { type: "boolean" }
    }, ["scope"]),
    tool("minecraft_start_behavior", "立即提交一个高层实时行为。控制工具必须独占一轮。", {
      kind: { type: "string", enum: ["go_to", "follow_and_assist", "interact_entity", "collect_item", "chat", "combat"] },
      position: vec3JsonSchema(),
      tolerance: { type: "number" },
      targetRef: { type: "string" },
      followDistance: { type: "number" },
      lostTargetWaitSeconds: { type: "integer" },
      interaction: { type: "string", enum: ["use", "mount", "feed"] },
      text: { type: "string" },
      channel: { type: "string", enum: ["global", "team"] },
      stopHealth: { type: "number" },
      ...revisionJsonProperties()
    }, ["kind", "expectedActorRevision", "expectedObservationRevision", "idempotencyKey", "decisionReason"]),
    tool("minecraft_submit_task", "提交可排队、可追踪的高层任务；适合非即时工作。控制工具必须独占一轮。", {
      kind: { type: "string", enum: ["go_to", "collect_item", "interact_entity", "chat", "combat"] },
      arguments: { type: "object" },
      priority: { type: "string", enum: ["low", "normal", "high"] },
      ...revisionJsonProperties()
    }, ["kind", "arguments", "priority", "expectedActorRevision", "expectedObservationRevision", "idempotencyKey", "decisionReason"]),
    tool("minecraft_cancel_behavior", "取消当前行为；若行为属于任务，会同时终止任务。", {
      expectedActorRevision: { type: "integer", minimum: 0 },
      idempotencyKey: { type: "string" },
      reason: { type: "string" }
    }, ["expectedActorRevision", "idempotencyKey", "reason"]),
    tool("minecraft_cancel_task", "取消指定的排队中或运行中任务。", {
      taskId: { type: "string" },
      expectedActorRevision: { type: "integer", minimum: 0 },
      idempotencyKey: { type: "string" },
      reason: { type: "string" }
    }, ["taskId", "expectedActorRevision", "idempotencyKey", "reason"]),
    tool(TERMINAL_TOOL_NAME, "结束本次决策并提交更新后的持久状态。结束工具必须独占一轮。", {
      summary: { type: "string" },
      persistentState: { type: "string" },
      currentGoal: { type: ["string", "null"] },
      nextWakeHint: { type: "string" }
    }, ["summary", "persistentState"])
  ];
  if (options.includeAutonomy) {
    tools.splice(-1, 0, tool("minecraft_set_autonomy", "修改 Actor 空闲自治策略。仅授权的控制循环可见。", {
      policy: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          idleDelayMs: { type: "integer", minimum: 1_000, maximum: 300_000 },
          collectItems: { type: "boolean" },
          explore: { type: "boolean" },
          combatHostiles: { type: "boolean" },
          exploreRadius: { type: "number", minimum: 4, maximum: 64 },
          combatStopHealth: { type: "number", minimum: 2, maximum: 18 }
        },
        required: ["enabled", "idleDelayMs", "collectItems", "explore", "combatHostiles", "exploreRadius", "combatStopHealth"]
      },
      expectedActorRevision: { type: "integer", minimum: 0 },
      idempotencyKey: { type: "string" }
    }, ["policy", "expectedActorRevision", "idempotencyKey"]));
  }
  if (options.includeProgramDeployment) {
    tools.splice(-1, 0,
      tool("minecraft_get_active_program", "读取当前已激活的 Python 行为程序及其版本；这是只读操作。", {}),
      tool("minecraft_validate_program", "静态校验一个完整 Python 行为程序并创建短期草稿；不会激活或执行。", {
        programId: { type: "string", minLength: 1, maxLength: 128 },
        programVersion: { type: "integer", minimum: 1 },
        expectedActorRevision: { type: "integer", minimum: 0 },
        source: { type: "string", minLength: 1, maxLength: 100_000 },
        requiredCapabilities: {
          type: "array",
          maxItems: 128,
          uniqueItems: true,
          items: { type: "string", minLength: 1 }
        },
        summary: { type: "string", maxLength: 4_000 }
      }, ["programId", "programVersion", "expectedActorRevision", "source", "requiredCapabilities"]),
      tool("minecraft_activate_program", "原子激活已通过校验的程序草稿。属于控制提交，必须独占一轮。", {
        draftId: { type: "string", minLength: 1 },
        expectedActorRevision: { type: "integer", minimum: 0 },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
        decisionReason: { type: "string", minLength: 1, maxLength: 300 }
      }, ["draftId", "expectedActorRevision", "idempotencyKey", "decisionReason"])
    );
  }
  return tools;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): LlmToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties,
        ...(required.length > 0 ? { required } : {})
      }
    }
  };
}

function revisionJsonProperties(): Record<string, unknown> {
  return {
    expectedActorRevision: { type: "integer", minimum: 0 },
    expectedObservationRevision: { type: "integer", minimum: 0 },
    idempotencyKey: { type: "string", description: "为本次控制新生成且后续重试保持不变的幂等键。" },
    decisionReason: { type: "string" }
  };
}

function vec3JsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      x: { type: "number" },
      y: { type: "number" },
      z: { type: "number" }
    },
    required: ["x", "y", "z"]
  };
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function commandExecutionResult(result: { ok: boolean }): {
  result: string;
  committed: boolean;
} {
  return { result: jsonResult(result), committed: result.ok };
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}
