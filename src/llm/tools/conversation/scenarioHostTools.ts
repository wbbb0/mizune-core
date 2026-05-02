import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";
import { keepRawUnlessLargePolicy, stateChangePolicy } from "../core/resultObservationPresets.ts";
import type { ScenarioHostInventoryItem, ScenarioHostObjective, ScenarioHostSessionState } from "#modes/scenarioHost/types.ts";
import { resolveSessionParticipantLabel, resolveSessionParticipantRef } from "#conversation/session/sessionIdentity.ts";

function ensureScenarioHostMode(context: Parameters<ToolHandler>[2]): string | null {
  const modeId = context.sessionManager.getModeId(context.lastMessage.sessionId);
  return modeId === "scenario_host" ? null : JSON.stringify({ error: "Current session is not using scenario_host mode" });
}

function getScenarioDefaults(context: Parameters<ToolHandler>[2]) {
  const session = context.sessionManager.getSession(context.lastMessage.sessionId);
  const participantRef = resolveSessionParticipantRef({
    sessionId: session.id,
    type: session.type,
    participantRef: session.participantRef
  });
  return {
    playerUserId: participantRef.id,
    playerDisplayName: resolveSessionParticipantLabel({
      sessionId: session.id,
      participantRef,
      title: session.title,
      type: session.type
    })
  };
}

export const scenarioHostToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "get_scenario_state",
        description: "读取当前 scenario_host 会话的结构化场景状态。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
  },
  {
    definition: {
      type: "function",
      function: {
        name: "update_scenario_state",
        description: "更新当前 scenario_host 场景的受控字段，不可整体覆写完整状态。",
        parameters: {
          type: "object",
          properties: {
            currentSituation: { type: "string" },
            sceneSummary: { type: "string" },
            turnIndex: { type: "number" },
            flags: { type: "object", additionalProperties: true }
          },
          additionalProperties: false
        }
      }
    },
    resultObservation: stateChangePolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "set_current_location",
        description: "设置当前场景所在地点。",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string" }
          },
          required: ["location"],
          additionalProperties: false
        }
      }
    },
    resultObservation: stateChangePolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "manage_objective",
        description: "新增、更新或删除场景目标。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["upsert", "remove"] },
            id: { type: "string" },
            title: { type: "string" },
            status: { type: "string", enum: ["active", "completed", "failed"] },
            summary: { type: "string" }
          },
          required: ["action", "id"],
          additionalProperties: false
        }
      }
    },
    resultObservation: stateChangePolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "manage_inventory",
        description: "新增、更新或删除场景背包条目。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["upsert", "remove"] },
            ownerId: { type: "string" },
            item: { type: "string" },
            quantity: { type: "number" }
          },
          required: ["action", "ownerId", "item"],
          additionalProperties: false
        }
      }
    },
    resultObservation: stateChangePolicy()
  },
  {
    definition: {
      type: "function",
      function: {
        name: "append_world_fact",
        description: "向当前场景追加一条世界事实。",
        parameters: {
          type: "object",
          properties: {
            fact: { type: "string" }
          },
          required: ["fact"],
          additionalProperties: false
        }
      }
    },
    resultObservation: stateChangePolicy()
  }
];

export const scenarioHostToolHandlers: Record<string, ToolHandler> = {
  async get_scenario_state(_toolCall, _args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const state = await context.scenarioHostStateStore.ensure(context.lastMessage.sessionId, getScenarioDefaults(context));
    return JSON.stringify(state);
  },
  async update_scenario_state(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const currentSituation = getStringArg(args, "currentSituation").trim();
    const sceneSummary = getStringArg(args, "sceneSummary").trim();
    const turnIndex = getNumberArg(args, "turnIndex");
    const rawFlags = typeof args === "object" && args != null && "flags" in args
      ? (args as { flags?: unknown }).flags
      : undefined;
    const flags: Record<string, string | number | boolean> | undefined = typeof rawFlags === "object" && rawFlags != null
      ? Object.fromEntries(
          Object.entries(rawFlags as Record<string, unknown>)
            .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
        ) as Record<string, string | number | boolean>
      : undefined;
    const state = await context.scenarioHostStateStore.update(
      context.lastMessage.sessionId,
      (current) => ({
        ...current,
        ...(currentSituation ? { currentSituation } : {}),
        ...(sceneSummary ? { sceneSummary } : {}),
        ...(Number.isFinite(turnIndex) ? { turnIndex: Math.max(0, Math.round(turnIndex!)) } : {}),
        ...(flags ? { flags: { ...current.flags, ...flags } } : {})
      }),
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_state_updated");
    return JSON.stringify(state);
  },
  async set_current_location(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const location = getStringArg(args, "location").trim();
    if (!location) {
      return JSON.stringify({ error: "location is required" });
    }
    const state = await context.scenarioHostStateStore.update(
      context.lastMessage.sessionId,
      (current) => ({
        ...current,
        currentLocation: location
      }),
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_location_updated");
    return JSON.stringify(state);
  },
  async manage_objective(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const action = getStringArg(args, "action").trim();
    const id = getStringArg(args, "id").trim();
    if (!action || !id) {
      return JSON.stringify({ error: "action and id are required" });
    }
    const state = await context.scenarioHostStateStore.update(
      context.lastMessage.sessionId,
      (current: ScenarioHostSessionState) => {
        if (action === "remove") {
          return {
            ...current,
            objectives: current.objectives.filter((item: ScenarioHostSessionState["objectives"][number]) => item.id !== id)
          };
        }
        const title = getStringArg(args, "title").trim();
        if (!title) {
          return current;
        }
        const statusArg = getStringArg(args, "status").trim();
        const summary = getStringArg(args, "summary").trim();
        const nextObjective: ScenarioHostObjective = {
          id,
          title,
          status: statusArg === "completed" || statusArg === "failed" ? statusArg : "active",
          summary
        };
        const index = current.objectives.findIndex((item: ScenarioHostSessionState["objectives"][number]) => item.id === id);
        const objectives = [...current.objectives];
        if (index >= 0) {
          objectives[index] = nextObjective;
        } else {
          objectives.push(nextObjective);
        }
        return {
          ...current,
          objectives
        };
      },
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_objective_updated");
    return JSON.stringify(state);
  },
  async manage_inventory(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const action = getStringArg(args, "action").trim();
    const ownerId = getStringArg(args, "ownerId").trim();
    const item = getStringArg(args, "item").trim();
    if (!action || !ownerId || !item) {
      return JSON.stringify({ error: "action, ownerId, and item are required" });
    }
    const quantity = Math.max(1, Math.round(getNumberArg(args, "quantity") ?? 1));
    const state = await context.scenarioHostStateStore.update(
      context.lastMessage.sessionId,
      (current: ScenarioHostSessionState) => {
        if (action === "remove") {
          return {
            ...current,
            inventory: current.inventory.filter((entry: ScenarioHostSessionState["inventory"][number]) => !(entry.ownerId === ownerId && entry.item === item))
          };
        }
        const nextEntry: ScenarioHostInventoryItem = {
          ownerId,
          item,
          quantity
        };
        const index = current.inventory.findIndex((entry: ScenarioHostSessionState["inventory"][number]) => entry.ownerId === ownerId && entry.item === item);
        const inventory = [...current.inventory];
        if (index >= 0) {
          inventory[index] = nextEntry;
        } else {
          inventory.push(nextEntry);
        }
        return {
          ...current,
          inventory
        };
      },
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_inventory_updated");
    return JSON.stringify(state);
  },
  async append_world_fact(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const fact = getStringArg(args, "fact").trim();
    if (!fact) {
      return JSON.stringify({ error: "fact is required" });
    }
    const state = await context.scenarioHostStateStore.update(
      context.lastMessage.sessionId,
      (current) => ({
        ...current,
        worldFacts: current.worldFacts.includes(fact)
          ? current.worldFacts
          : [...current.worldFacts, fact]
      }),
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_world_fact_appended");
    return JSON.stringify(state);
  }
};
