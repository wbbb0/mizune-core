import { createHash } from "node:crypto";
import type { MinecraftActorRecoveryState, RuntimeResourceRecord } from "#runtime/resources/resourceTypes.ts";
import type {
  JsonValue,
  MinecraftAutonomyPolicy,
  MinecraftBehaviorCommand,
  MinecraftObservationRequest,
  MinecraftProgramDocument,
  MinecraftTaskCommand,
  MinecraftTaskKind,
  MinecraftTaskPriority
} from "#services/minecraft/actorTypes.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOwner } from "../core/shared.ts";
import { keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";

const isMinecraftEnabled: ToolDescriptor["isEnabled"] = config => config.minecraft.enabled;
const ownerTool = (definition: ToolDescriptor["definition"]): ToolDescriptor => ({
  ownerOnly: true,
  definition,
  isEnabled: isMinecraftEnabled,
  resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
});

const resourceIdProperty = { type: "string", description: "Minecraft Actor resource_id" } as const;

export const minecraftActorToolDescriptors: ToolDescriptor[] = [
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_list",
      description: "列出持久 Minecraft Actor 资源及服务端允许创建的 endpoint ID。",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_create",
      description: "从服务端预配置的 endpoint 创建或复用 Minecraft Actor。socket 路径、账号和权限不能由模型提供。",
      parameters: {
        type: "object",
        properties: {
          endpoint_id: { type: "string" },
          title: { type: "string", maxLength: 200 },
          persistent_state: { type: "string", maxLength: 20_000 },
          current_goal: { type: ["string", "null"], maxLength: 500 }
        },
        required: ["endpoint_id"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_probe",
      description: "读取 Actor 当前自身、行为、任务、动作租约和自治策略快照。",
      parameters: {
        type: "object",
        properties: { resource_id: resourceIdProperty },
        required: ["resource_id"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_observe",
      description: "读取 Actor 的自身、环境、背包、实体、玩家、聊天或任务结构化状态。实体引用只应来自本工具的当前返回值。",
      parameters: {
        type: "object",
        properties: {
          resource_id: resourceIdProperty,
          scope: { type: "string", enum: ["self", "environment", "inventory", "entities", "player", "chat", "tasks"] },
          kind: { type: "string", enum: ["player", "hostile", "passive", "item"] },
          radius: { type: "number", minimum: 1, maximum: 128 },
          limit: { type: "integer", minimum: 1, maximum: 128 },
          player_uuid: { type: "string" },
          after_message_id: { type: "string" },
          include_completed: { type: "boolean" }
        },
        required: ["resource_id", "scope"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_start_behavior",
      description: "立即启动一个确定性高层行为。用于跟随或需要立刻开始的移动、交互、拾取、聊天和战斗；系统自动读取 revision 并生成幂等键。",
      parameters: {
        type: "object",
        properties: {
          resource_id: resourceIdProperty,
          kind: { type: "string", enum: ["go_to", "follow_and_assist", "interact_entity", "collect_item", "chat", "combat"] },
          position: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
            required: ["x", "y", "z"],
            additionalProperties: false
          },
          target_ref: { type: "string" },
          tolerance: { type: "number", minimum: 0.25, maximum: 8 },
          follow_distance: { type: "number", minimum: 2, maximum: 6 },
          lost_target_wait_seconds: { type: "integer", minimum: 3, maximum: 30 },
          interaction: { type: "string", enum: ["use", "mount", "feed"] },
          text: { type: "string", minLength: 1, maxLength: 256 },
          channel: { type: "string", enum: ["global", "team"] },
          stop_health: { type: "number", minimum: 2, maximum: 18 },
          reason: { type: "string", minLength: 1, maxLength: 500 }
        },
        required: ["resource_id", "kind", "reason"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_submit_task",
      description: "把移动、拾取、实体交互、聊天或战斗放入持久任务队列。系统自动读取 revision 并生成幂等键。",
      parameters: {
        type: "object",
        properties: {
          resource_id: resourceIdProperty,
          kind: { type: "string", enum: ["go_to", "collect_item", "interact_entity", "chat", "combat"] },
          arguments: { type: "object", description: "任务参数；字段与对应 behavior 一致，使用 camelCase。" },
          priority: { type: "string", enum: ["low", "normal", "high"] },
          reason: { type: "string", minLength: 1, maxLength: 500 }
        },
        required: ["resource_id", "kind", "arguments", "priority", "reason"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_cancel",
      description: "取消当前行为；提供 task_id 时取消指定任务。系统自动读取 revision 并生成幂等键。",
      parameters: {
        type: "object",
        properties: {
          resource_id: resourceIdProperty,
          task_id: { type: "string" },
          reason: { type: "string", minLength: 1, maxLength: 500 }
        },
        required: ["resource_id", "reason"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_set_autonomy",
      description: "修改 Actor 空闲自治策略。只允许配置中明确授权的 Actor；未提供的字段保留当前值。",
      parameters: {
        type: "object",
        properties: {
          resource_id: resourceIdProperty,
          enabled: { type: "boolean" },
          idle_delay_ms: { type: "integer", minimum: 1000, maximum: 300000 },
          collect_items: { type: "boolean" },
          explore: { type: "boolean" },
          combat_hostiles: { type: "boolean" },
          explore_radius: { type: "number", minimum: 4, maximum: 64 },
          combat_stop_health: { type: "number", minimum: 2, maximum: 18 }
        },
        required: ["resource_id"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_get_program",
      description: "读取 Actor 当前已激活的 Python 行为程序。",
      parameters: {
        type: "object",
        properties: { resource_id: resourceIdProperty },
        required: ["resource_id"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_validate_program",
      description: "把完整 Python 源码提交为不可执行草稿并做静态验证。验证通过不会自动替换当前程序，必须再显式 activate。",
      parameters: {
        type: "object",
        properties: {
          resource_id: resourceIdProperty,
          program_id: { type: "string", minLength: 1, maxLength: 128 },
          program_version: { type: "integer", minimum: 1 },
          source: { type: "string", minLength: 1, maxLength: 100_000 },
          required_capabilities: {
            type: "array",
            maxItems: 128,
            uniqueItems: true,
            items: { type: "string", minLength: 1 }
          },
          summary: { type: "string", maxLength: 4_000 }
        },
        required: ["resource_id", "program_id", "program_version", "source", "required_capabilities"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_activate_program",
      description: "原子激活一个已验证 draft。系统自动读取 revision 并生成幂等键；资源必须由服务端授权程序部署。",
      parameters: {
        type: "object",
        properties: {
          resource_id: resourceIdProperty,
          draft_id: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1, maxLength: 500 }
        },
        required: ["resource_id", "draft_id", "reason"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_wake",
      description: "显式唤醒 Actor 的上层模型决策循环。不要用于可由现成行为或任务直接完成的动作。",
      parameters: {
        type: "object",
        properties: {
          resource_id: resourceIdProperty,
          summary: { type: "string", minLength: 1, maxLength: 500 },
          priority: { type: "string", enum: ["normal", "high", "critical"] },
          interrupt_current: { type: "boolean" }
        },
        required: ["resource_id", "summary"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_ingest_events",
      description: "立即拉取一次 Runtime 事件并推进持久 outbox；主要用于开发诊断，正常情况由后台服务自动执行。",
      parameters: {
        type: "object",
        properties: { resource_id: resourceIdProperty },
        required: ["resource_id"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_close",
      description: "永久关闭父项目中的 Actor 资源并释放本地 transport。不会把任意远端停机语义藏在 transport close 中。",
      parameters: {
        type: "object",
        properties: {
          resource_id: resourceIdProperty,
          reason: { type: "string", maxLength: 500 }
        },
        required: ["resource_id"],
        additionalProperties: false
      }
    }
  })
];

export const minecraftActorToolHandlers: Record<string, ToolHandler> = {
  async minecraft_actor_list(_toolCall, _args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const resources = await context.minecraftActorManager!.list();
    return json({
      ok: true,
      endpoint_ids: context.minecraftActorProvisioning!.listEndpointIds(),
      resources: resources.map(toResourceSummary)
    });
  },

  async minecraft_actor_create(_toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const endpointId = requiredString(input.endpoint_id, "endpoint_id");
    const title = optionalBoundedString(input.title, "title", 200);
    const persistentState = optionalBoundedString(input.persistent_state, "persistent_state", 20_000);
    const resource = await context.minecraftActorProvisioning!.ensure({
      endpointId,
      ownerSessionId: context.lastMessage.sessionId,
      ...(title === undefined ? {} : { title }),
      ...(persistentState === undefined ? {} : { persistentState }),
      ...(input.current_goal === undefined
        ? {}
        : { currentGoal: input.current_goal === null ? null : boundedString(input.current_goal, "current_goal", 500) })
    });
    return json({ ok: true, resource: toResourceSummary(resource) });
  },

  async minecraft_actor_probe(_toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const resourceId = resourceIdFrom(args);
    return json({ ok: true, resource_id: resourceId, snapshot: await context.minecraftActorManager!.probe(resourceId, context.abortSignal) });
  },

  async minecraft_actor_observe(_toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const resourceId = requiredString(input.resource_id, "resource_id");
    const request = observationRequest(input);
    return json({ ok: true, resource_id: resourceId, observation: await context.minecraftActorManager!.observe(resourceId, request, context.abortSignal) });
  },

  async minecraft_actor_start_behavior(toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const resourceId = requiredString(input.resource_id, "resource_id");
    const snapshot = await context.minecraftActorManager!.probe(resourceId, context.abortSignal);
    const command = behaviorCommand(input, {
      actorRevision: snapshot.actorRevision,
      observationRevision: snapshot.observationRevision,
      idempotencyKey: toolIdempotencyKey(context.lastMessage.sessionId, toolCall.id, resourceId, "start_behavior")
    });
    const result = await context.minecraftActorManager!.startBehavior(resourceId, command, context.abortSignal);
    return json({ ok: result.ok, resource_id: resourceId, result });
  },

  async minecraft_actor_submit_task(toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const resourceId = requiredString(input.resource_id, "resource_id");
    const kind = enumValue(input.kind, "kind", ["go_to", "collect_item", "interact_entity", "chat", "combat"] as const);
    const priority = enumValue(input.priority, "priority", ["low", "normal", "high"] as const);
    const taskArguments = jsonRecord(input.arguments, "arguments");
    const snapshot = await context.minecraftActorManager!.probe(resourceId, context.abortSignal);
    const command: MinecraftTaskCommand = {
      kind: kind as MinecraftTaskKind,
      arguments: taskArguments,
      priority: priority as MinecraftTaskPriority,
      expectedActorRevision: snapshot.actorRevision,
      expectedObservationRevision: snapshot.observationRevision,
      idempotencyKey: toolIdempotencyKey(context.lastMessage.sessionId, toolCall.id, resourceId, "submit_task"),
      decisionReason: boundedString(input.reason, "reason", 500)
    };
    const result = await context.minecraftActorManager!.submitTask(resourceId, command, context.abortSignal);
    return json({ ok: result.ok, resource_id: resourceId, result });
  },

  async minecraft_actor_cancel(toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const resourceId = requiredString(input.resource_id, "resource_id");
    const reason = boundedString(input.reason, "reason", 500);
    const snapshot = await context.minecraftActorManager!.probe(resourceId, context.abortSignal);
    const idempotencyKey = toolIdempotencyKey(context.lastMessage.sessionId, toolCall.id, resourceId, "cancel");
    const taskId = optionalString(input.task_id, "task_id");
    const result = taskId
      ? await context.minecraftActorManager!.cancelTask(resourceId, {
          taskId,
          expectedActorRevision: snapshot.actorRevision,
          idempotencyKey,
          reason
        }, context.abortSignal)
      : await context.minecraftActorManager!.cancelBehavior(resourceId, {
          expectedActorRevision: snapshot.actorRevision,
          idempotencyKey,
          reason
        }, context.abortSignal);
    return json({ ok: result.ok, resource_id: resourceId, result });
  },

  async minecraft_actor_set_autonomy(toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const resourceId = requiredString(input.resource_id, "resource_id");
    const snapshot = await context.minecraftActorManager!.probe(resourceId, context.abortSignal);
    const policy = mergeAutonomyPolicy(snapshot.autonomyPolicy, input);
    const result = await context.minecraftActorManager!.setAutonomy(resourceId, {
      policy,
      expectedActorRevision: snapshot.actorRevision,
      idempotencyKey: toolIdempotencyKey(context.lastMessage.sessionId, toolCall.id, resourceId, "set_autonomy")
    }, context.abortSignal);
    return json({ ok: result.ok, resource_id: resourceId, result });
  },

  async minecraft_actor_get_program(_toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const resourceId = resourceIdFrom(args);
    const program = await context.minecraftActorManager!.getActiveProgram(resourceId, context.abortSignal);
    return json({ ok: true, resource_id: resourceId, program });
  },

  async minecraft_actor_validate_program(toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const resourceId = requiredString(input.resource_id, "resource_id");
    const source = boundedRawString(input.source, "source", 100_000);
    const capabilities = stringArray(input.required_capabilities, "required_capabilities", 128, 256);
    const snapshot = await context.minecraftActorManager!.probe(resourceId, context.abortSignal);
    const resource = await context.minecraftActorManager!.get(resourceId);
    const actor = resource?.minecraftActor;
    const summary = optionalBoundedString(input.summary, "summary", 4_000);
    const document: MinecraftProgramDocument = {
      protocolVersion: 1,
      programId: boundedString(input.program_id, "program_id", 128),
      programVersion: boundedInteger(input.program_version, "program_version", 1, Number.MAX_SAFE_INTEGER),
      expectedActorRevision: snapshot.actorRevision,
      language: "python",
      apiVersion: "mizune.mc.v1",
      entrypoint: "main",
      source,
      sourceHash: `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`,
      requiredCapabilities: capabilities,
      metadata: {
        decisionId: toolCall.id,
        createdAtMs: Date.now(),
        ...(actor?.modelRefs[0] ? { modelRef: actor.modelRefs[0] } : {}),
        ...(summary === undefined ? {} : { summary })
      }
    };
    const validation = await context.minecraftActorManager!.validateProgram(resourceId, document, context.abortSignal);
    return json({ ok: validation.ok, resource_id: resourceId, validation });
  },

  async minecraft_actor_activate_program(toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const resourceId = requiredString(input.resource_id, "resource_id");
    const snapshot = await context.minecraftActorManager!.probe(resourceId, context.abortSignal);
    const result = await context.minecraftActorManager!.activateProgram(resourceId, {
      draftId: requiredString(input.draft_id, "draft_id"),
      expectedActorRevision: snapshot.actorRevision,
      idempotencyKey: toolIdempotencyKey(context.lastMessage.sessionId, toolCall.id, resourceId, "activate_program"),
      decisionReason: boundedString(input.reason, "reason", 500)
    }, context.abortSignal);
    return json({ ok: result.ok, resource_id: resourceId, result });
  },

  async minecraft_actor_wake(_toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const resourceId = requiredString(input.resource_id, "resource_id");
    const outcome = await context.minecraftActorManager!.wake(resourceId, {
      type: "owner_request",
      summary: boundedString(input.summary, "summary", 500),
      occurredAtMs: Date.now(),
      priority: input.priority === undefined
        ? "normal"
        : enumValue(input.priority, "priority", ["normal", "high", "critical"] as const),
      interruptCurrent: optionalBoolean(input.interrupt_current, "interrupt_current") ?? false
    });
    return json({ ok: outcome.status === "completed", resource_id: resourceId, outcome });
  },

  async minecraft_actor_ingest_events(_toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const resourceId = resourceIdFrom(args);
    const ingestion = await context.minecraftActorManager!.ingestEvents(resourceId);
    return json({
      ok: true,
      resource_id: resourceId,
      events: ingestion.events,
      wake_started: ingestion.wake !== null
    });
  },

  async minecraft_actor_close(_toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const resourceId = requiredString(input.resource_id, "resource_id");
    await context.minecraftActorManager!.close(resourceId, optionalString(input.reason, "reason") ?? "owner_closed");
    return json({ ok: true, resource_id: resourceId, status: "closed" });
  }
};

function requireMinecraftOwner(context: Parameters<ToolHandler>[2]): string | null {
  const denied = requireOwner(context.relationship, "only owner can control Minecraft Actor resources");
  if (denied) return denied;
  if (!context.config.minecraft.enabled || !context.minecraftActorManager || !context.minecraftActorProvisioning) {
    return json({ error: "Minecraft Actor runtime is not available" });
  }
  return null;
}

function observationRequest(input: Record<string, unknown>): MinecraftObservationRequest {
  const scope = enumValue(input.scope, "scope", ["self", "environment", "inventory", "entities", "player", "chat", "tasks"] as const);
  if (scope === "self" || scope === "environment" || scope === "inventory") return { scope };
  if (scope === "player") return { scope, playerUuid: requiredString(input.player_uuid, "player_uuid") };
  if (scope === "entities") {
    return {
      scope,
      ...(input.kind === undefined ? {} : { kind: enumValue(input.kind, "kind", ["player", "hostile", "passive", "item"] as const) }),
      ...(input.radius === undefined ? {} : { radius: boundedNumber(input.radius, "radius", 1, 128) }),
      ...(input.limit === undefined ? {} : { limit: boundedInteger(input.limit, "limit", 1, 128) })
    };
  }
  if (scope === "chat") {
    return {
      scope,
      ...(input.after_message_id === undefined ? {} : { afterMessageId: requiredString(input.after_message_id, "after_message_id") }),
      ...(input.limit === undefined ? {} : { limit: boundedInteger(input.limit, "limit", 1, 128) })
    };
  }
  return {
    scope: "tasks",
    ...(input.include_completed === undefined ? {} : { includeCompleted: requiredBoolean(input.include_completed, "include_completed") }),
    ...(input.limit === undefined ? {} : { limit: boundedInteger(input.limit, "limit", 1, 128) })
  };
}

function behaviorCommand(
  input: Record<string, unknown>,
  revision: { actorRevision: number; observationRevision: number; idempotencyKey: string }
): MinecraftBehaviorCommand {
  const common = {
    expectedActorRevision: revision.actorRevision,
    expectedObservationRevision: revision.observationRevision,
    idempotencyKey: revision.idempotencyKey,
    decisionReason: boundedString(input.reason, "reason", 500)
  };
  const kind = enumValue(input.kind, "kind", ["go_to", "follow_and_assist", "interact_entity", "collect_item", "chat", "combat"] as const);
  if (kind === "go_to") {
    const position = record(input.position, "position");
    return {
      ...common,
      kind,
      position: {
        x: finiteNumber(position.x, "position.x"),
        y: finiteNumber(position.y, "position.y"),
        z: finiteNumber(position.z, "position.z")
      },
      tolerance: input.tolerance === undefined ? 1 : boundedNumber(input.tolerance, "tolerance", 0.25, 8)
    };
  }
  if (kind === "follow_and_assist") {
    return {
      ...common,
      kind,
      targetRef: requiredString(input.target_ref, "target_ref"),
      followDistance: input.follow_distance === undefined ? 3 : boundedNumber(input.follow_distance, "follow_distance", 2, 6),
      lostTargetWaitSeconds: input.lost_target_wait_seconds === undefined
        ? 15
        : boundedInteger(input.lost_target_wait_seconds, "lost_target_wait_seconds", 3, 30)
    };
  }
  if (kind === "interact_entity") {
    return {
      ...common,
      kind,
      targetRef: requiredString(input.target_ref, "target_ref"),
      interaction: enumValue(input.interaction, "interaction", ["use", "mount", "feed"] as const)
    };
  }
  if (kind === "collect_item") {
    return { ...common, kind, targetRef: requiredString(input.target_ref, "target_ref") };
  }
  if (kind === "chat") {
    return {
      ...common,
      kind,
      text: boundedString(input.text, "text", 256),
      channel: enumValue(input.channel, "channel", ["global", "team"] as const)
    };
  }
  return {
    ...common,
    kind: "combat",
    targetRef: requiredString(input.target_ref, "target_ref"),
    stopHealth: input.stop_health === undefined ? 8 : boundedNumber(input.stop_health, "stop_health", 2, 18)
  };
}

function mergeAutonomyPolicy(current: MinecraftAutonomyPolicy, input: Record<string, unknown>): MinecraftAutonomyPolicy {
  const fields = [
    "enabled",
    "idle_delay_ms",
    "collect_items",
    "explore",
    "combat_hostiles",
    "explore_radius",
    "combat_stop_health"
  ];
  if (!fields.some(field => input[field] !== undefined)) throw new Error("至少提供一个自治策略字段");
  return {
    enabled: optionalBoolean(input.enabled, "enabled") ?? current.enabled,
    idleDelayMs: input.idle_delay_ms === undefined ? current.idleDelayMs : boundedInteger(input.idle_delay_ms, "idle_delay_ms", 1_000, 300_000),
    collectItems: optionalBoolean(input.collect_items, "collect_items") ?? current.collectItems,
    explore: optionalBoolean(input.explore, "explore") ?? current.explore,
    combatHostiles: optionalBoolean(input.combat_hostiles, "combat_hostiles") ?? current.combatHostiles,
    exploreRadius: input.explore_radius === undefined ? current.exploreRadius : boundedNumber(input.explore_radius, "explore_radius", 4, 64),
    combatStopHealth: input.combat_stop_health === undefined ? current.combatStopHealth : boundedNumber(input.combat_stop_health, "combat_stop_health", 2, 18)
  };
}

function toResourceSummary(record: RuntimeResourceRecord) {
  const actor = record.minecraftActor as MinecraftActorRecoveryState | undefined;
  return {
    resource_id: record.resourceId,
    status: record.status,
    actor_id: actor?.actorId ?? null,
    current_goal: actor?.currentGoal ?? null,
    last_event_sequence: actor?.lastEventSequence ?? null,
    allow_autonomy_policy_change: actor?.allowAutonomyPolicyChange ?? false,
    allow_program_deployment: actor?.allowProgramDeployment ?? false,
    owner_session_id: record.ownerSessionId,
    title: record.title,
    summary: record.summary
  };
}

function toolIdempotencyKey(sessionId: string, toolCallId: string, resourceId: string, action: string): string {
  const digest = createHash("sha256")
    .update(`${sessionId}\0${toolCallId}\0${resourceId}\0${action}`, "utf8")
    .digest("hex");
  return `tool:${digest}`;
}

function resourceIdFrom(args: unknown): string {
  return requiredString(record(args).resource_id, "resource_id");
}

function record(value: unknown, name = "arguments"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}

function jsonRecord(value: unknown, name: string): Record<string, JsonValue> {
  const input = record(value, name);
  JSON.stringify(input, (_key, child) => {
    if (typeof child === "number" && !Number.isFinite(child)) throw new Error(`${name} 包含非有限数值`);
    if (child === undefined || typeof child === "bigint" || typeof child === "function" || typeof child === "symbol") {
      throw new Error(`${name} 不是 JSON 值`);
    }
    return child;
  });
  return input as Record<string, JsonValue>;
}

function stringArray(value: unknown, name: string, maxItems: number, maxItemLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${name} 必须是不超过 ${maxItems} 项的数组`);
  }
  const result = value.map((item, index) => boundedString(item, `${name}[${index}]`, maxItemLength));
  if (new Set(result).size !== result.length) throw new Error(`${name} 不能包含重复项`);
  return result;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  return value.trim();
}

function boundedString(value: unknown, name: string, maxLength: number): string {
  const result = requiredString(value, name);
  if (result.length > maxLength) throw new Error(`${name} 不能超过 ${maxLength} 字符`);
  return result;
}

function boundedRawString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  if (value.length > maxLength) throw new Error(`${name} 不能超过 ${maxLength} 字符`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, name);
}

function optionalBoundedString(value: unknown, name: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, name, maxLength);
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} 必须是布尔值`);
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  return value === undefined ? undefined : requiredBoolean(value, name);
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} 必须是有限数值`);
  return value;
}

function boundedNumber(value: unknown, name: string, min: number, max: number): number {
  const result = finiteNumber(value, name);
  if (result < min || result > max) throw new Error(`${name} 必须在 ${min} 到 ${max} 之间`);
  return result;
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  const result = boundedNumber(value, name, min, max);
  if (!Number.isSafeInteger(result)) throw new Error(`${name} 必须是安全整数`);
  return result;
}

function enumValue<const T extends readonly string[]>(value: unknown, name: string, allowed: T): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} 必须是 ${allowed.join("、")} 之一`);
  }
  return value as T[number];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}
