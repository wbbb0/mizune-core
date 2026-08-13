import { createHash } from "node:crypto";
import type { MinecraftActorRecoveryState, RuntimeResourceRecord } from "#runtime/resources/resourceTypes.ts";
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

// 主会话只拥有委派与生命周期控制面。观察、实时动作、任务与程序能力仅注册在
// MinecraftDecisionRunner 的私有工具上下文中，避免主 Bot 绕过 Actor 独立循环。
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
      description: "从服务端预配置的 endpoint 创建或复用独立 Minecraft Actor。socket、账号、模型和权限不能由模型提供。",
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
      name: "minecraft_actor_request",
      description: "把目标写入 Actor 的持久 FIFO mailbox，并异步唤醒其独立模型循环。只负责委派，不直接执行游戏动作。",
      parameters: {
        type: "object",
        properties: {
          resource_id: resourceIdProperty,
          instruction: { type: "string", minLength: 1, maxLength: 8_000 },
          constraints: { type: ["string", "null"], maxLength: 4_000 },
          priority: { type: "string", enum: ["normal", "high"] }
        },
        required: ["resource_id", "instruction"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_status",
      description: "读取 Actor 独立循环、最近委派与 Runtime 身体状态的安全摘要。不会返回 transport、模型引用或原始内部错误。",
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
      name: "minecraft_actor_interrupt",
      description: "打断 Actor 当前一次上层模型决策。不会伪装成游戏内紧急停手，也不会关闭持久资源。",
      parameters: {
        type: "object",
        properties: {
          resource_id: resourceIdProperty,
          reason: { type: "string", minLength: 1, maxLength: 500 }
        },
        required: ["resource_id"],
        additionalProperties: false
      }
    }
  }),
  ownerTool({
    type: "function",
    function: {
      name: "minecraft_actor_close",
      description: "永久关闭父项目中的 Actor 资源并取消未完成委派。远端动作依靠控制租约进入安全态。",
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
    const resources = await context.minecraftActorManager!.listOwned(context.lastMessage.userId);
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
      ownerPrincipalId: context.lastMessage.userId,
      ...(title === undefined ? {} : { title }),
      ...(persistentState === undefined ? {} : { persistentState }),
      ...(input.current_goal === undefined
        ? {}
        : {
            currentGoal: input.current_goal === null
              ? null
              : boundedString(input.current_goal, "current_goal", 500)
          })
    });
    return json({ ok: true, resource: toResourceSummary(resource) });
  },

  async minecraft_actor_request(toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const resourceId = requiredString(input.resource_id, "resource_id");
    const result = await context.minecraftActorManager!.request(resourceId, {
      ownerPrincipalId: context.lastMessage.userId,
      ownerSessionId: context.lastMessage.sessionId,
      instruction: boundedString(input.instruction, "instruction", 8_000),
      ...(input.constraints === undefined
        ? {}
        : {
            constraints: input.constraints === null
              ? null
              : boundedString(input.constraints, "constraints", 4_000)
          }),
      ...(input.priority === undefined
        ? {}
        : { priority: enumValue(input.priority, "priority", ["normal", "high"] as const) }),
      idempotencyKey: toolIdempotencyKey(
        context.lastMessage.sessionId,
        toolCall.id,
        resourceId,
        "request"
      )
    });
    void context.minecraftActorManager!.processMailbox(resourceId).catch(() => undefined);
    return json({
      ok: true,
      accepted: true,
      replayed: result.replayed,
      resource_id: resourceId,
      request_id: result.request.requestId,
      request_status: result.request.status,
      revision: result.revision
    });
  },

  async minecraft_actor_status(_toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const resourceId = requiredString(record(args).resource_id, "resource_id");
    return json({
      ok: true,
      status: await context.minecraftActorManager!.status(
        resourceId,
        context.lastMessage.userId,
        context.abortSignal
      )
    });
  },

  async minecraft_actor_interrupt(_toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const resourceId = requiredString(input.resource_id, "resource_id");
    const result = await context.minecraftActorManager!.interrupt(resourceId, {
      ownerPrincipalId: context.lastMessage.userId,
      ownerSessionId: context.lastMessage.sessionId,
      ...(input.reason === undefined
        ? {}
        : { reason: boundedString(input.reason, "reason", 500) })
    });
    return json({ ok: true, resource_id: resourceId, ...result });
  },

  async minecraft_actor_close(_toolCall, args, context) {
    const denied = requireMinecraftOwner(context);
    if (denied) return denied;
    const input = record(args);
    const resourceId = requiredString(input.resource_id, "resource_id");
    await context.minecraftActorManager!.close(
      resourceId,
      optionalBoundedString(input.reason, "reason", 500) ?? "owner_closed",
      { ownerPrincipalId: context.lastMessage.userId }
    );
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

function toResourceSummary(record: RuntimeResourceRecord) {
  const actor = record.minecraftActor as MinecraftActorRecoveryState | undefined;
  return {
    resource_id: record.resourceId,
    status: record.status,
    actor_id: actor?.actorId ?? null,
    current_goal: actor?.currentGoal ?? null,
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

function record(value: unknown, name = "arguments"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
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

function optionalBoundedString(value: unknown, name: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, name, maxLength);
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
