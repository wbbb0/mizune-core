import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getBooleanArg, getNumberArg, getStringArg, getStringArrayArg } from "../core/toolArgHelpers.ts";
import { keepRawUnlessLargePolicy, stateChangePolicy } from "../core/resultObservationPresets.ts";
import type { ScenarioHostEntity, ScenarioHostInventoryItem, ScenarioHostJournalEntry, ScenarioHostLoreEntry, ScenarioHostObjective, ScenarioHostRelation, ScenarioHostSessionState } from "#modes/scenarioHost/types.ts";
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
            mechanics: {
              type: "object",
              properties: {
                ruleStyle: { type: "string", enum: ["freeform", "light_checks", "dice"] },
                dicePolicy: { type: "string" },
                difficultyScale: { type: "string" },
                successStates: { type: "array", items: { type: "string" } }
              },
              additionalProperties: false
            },
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
        description: "新增、更新或删除场景目标。新增/更新用 action=upsert，并提供稳定 id 与 title；删除用 action=remove 和 id。",
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
        description: "新增、更新或删除场景背包条目。新增/更新用 action=upsert，并提供 ownerId、item、quantity；删除用 action=remove、ownerId、item。",
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
        name: "manage_lore_entry",
        description: "新增、更新、禁用或删除当前会话的 Lore 条目。用于长期世界信息、地点规则、伏笔和可被关键词激活的设定。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["upsert", "remove"] },
            id: { type: "string" },
            title: { type: "string" },
            content: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            activationKeys: { type: "array", items: { type: "string" } },
            enabled: { type: "boolean" },
            priority: { type: "number" }
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
        name: "manage_entity",
        description: "新增、更新或删除当前会话中的实体，包括 NPC、地点、阵营、物品、组织等。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["upsert", "remove"] },
            id: { type: "string" },
            kind: { type: "string", enum: ["npc", "location", "faction", "item", "organization", "other"] },
            name: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
            summary: { type: "string" },
            status: { type: "string" },
            locationId: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            notes: { type: "string" }
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
        name: "manage_relation",
        description: "新增、更新或删除当前会话中两个实体之间的关系。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["upsert", "remove"] },
            sourceId: { type: "string" },
            targetId: { type: "string" },
            kind: { type: "string" },
            summary: { type: "string" },
            strength: { type: "number" }
          },
          required: ["action", "sourceId", "targetId", "kind"],
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
        name: "append_journal_entry",
        description: "追加一条剧情日志，记录本轮或关键节点已经发生的事实。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
            entityIds: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } }
          },
          required: ["title", "summary"],
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
        description: "兼容旧工具：向当前场景追加一条 Lore 条目。新实现优先使用 manage_lore_entry。",
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
    const rawMechanics = typeof args === "object" && args != null && "mechanics" in args
      ? (args as { mechanics?: unknown }).mechanics
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
        ...(isRecord(rawMechanics) ? { mechanics: mergeMechanics(current.mechanics, rawMechanics) } : {}),
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
  async manage_lore_entry(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const action = getStringArg(args, "action");
    const id = getStringArg(args, "id");
    if (!action || !id) {
      return JSON.stringify({ error: "action and id are required" });
    }
    const state = await context.scenarioHostStateStore.update(
      context.lastMessage.sessionId,
      (current: ScenarioHostSessionState) => {
        if (action === "remove") {
          return { ...current, loreEntries: current.loreEntries.filter((entry) => entry.id !== id) };
        }
        const existing = current.loreEntries.find((entry) => entry.id === id);
        const title = getStringArg(args, "title") || existing?.title || id;
        const content = getStringArg(args, "content") || existing?.content || "";
        const nextEntry: ScenarioHostLoreEntry = {
          id,
          title,
          content,
          tags: getStringArrayArg(args, "tags") ?? existing?.tags ?? [],
          activationKeys: getStringArrayArg(args, "activationKeys") ?? existing?.activationKeys ?? [],
          enabled: getBooleanArg(args, "enabled") ?? existing?.enabled ?? true,
          priority: Math.trunc(getNumberArg(args, "priority") ?? existing?.priority ?? 100),
          createdAtTurn: existing?.createdAtTurn ?? current.turnIndex,
          updatedAtTurn: current.turnIndex
        };
        return { ...current, loreEntries: upsertBy(current.loreEntries, nextEntry, (entry) => entry.id === id) };
      },
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_lore_updated");
    return JSON.stringify(state);
  },
  async manage_entity(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const action = getStringArg(args, "action");
    const id = getStringArg(args, "id");
    if (!action || !id) {
      return JSON.stringify({ error: "action and id are required" });
    }
    const state = await context.scenarioHostStateStore.update(
      context.lastMessage.sessionId,
      (current: ScenarioHostSessionState) => {
        if (action === "remove") {
          return { ...current, entities: current.entities.filter((entry) => entry.id !== id) };
        }
        const existing = current.entities.find((entry) => entry.id === id);
        const kindArg = getStringArg(args, "kind");
        const name = getStringArg(args, "name") || existing?.name || id;
        const nextEntity: ScenarioHostEntity = {
          id,
          kind: isScenarioEntityKind(kindArg) ? kindArg : existing?.kind ?? "other",
          name,
          aliases: getStringArrayArg(args, "aliases") ?? existing?.aliases ?? [],
          summary: getStringArg(args, "summary") || existing?.summary || "",
          status: getStringArg(args, "status") || existing?.status || "",
          locationId: getStringArg(args, "locationId") || existing?.locationId || null,
          tags: getStringArrayArg(args, "tags") ?? existing?.tags ?? [],
          notes: getStringArg(args, "notes") || existing?.notes || ""
        };
        return { ...current, entities: upsertBy(current.entities, nextEntity, (entry) => entry.id === id) };
      },
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_entity_updated");
    return JSON.stringify(state);
  },
  async manage_relation(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const action = getStringArg(args, "action");
    const sourceId = getStringArg(args, "sourceId");
    const targetId = getStringArg(args, "targetId");
    const kind = getStringArg(args, "kind");
    if (!action || !sourceId || !targetId || !kind) {
      return JSON.stringify({ error: "action, sourceId, targetId, and kind are required" });
    }
    const state = await context.scenarioHostStateStore.update(
      context.lastMessage.sessionId,
      (current: ScenarioHostSessionState) => {
        const matches = (entry: ScenarioHostRelation) => entry.sourceId === sourceId && entry.targetId === targetId && entry.kind === kind;
        if (action === "remove") {
          return { ...current, relations: current.relations.filter((entry) => !matches(entry)) };
        }
        const existing = current.relations.find(matches);
        const nextRelation: ScenarioHostRelation = {
          sourceId,
          targetId,
          kind,
          summary: getStringArg(args, "summary") || existing?.summary || "",
          strength: Math.max(-100, Math.min(100, Math.trunc(getNumberArg(args, "strength") ?? existing?.strength ?? 0))),
          updatedAtTurn: current.turnIndex
        };
        return { ...current, relations: upsertBy(current.relations, nextRelation, matches) };
      },
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_relation_updated");
    return JSON.stringify(state);
  },
  async append_journal_entry(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const title = getStringArg(args, "title");
    const summary = getStringArg(args, "summary");
    if (!title || !summary) {
      return JSON.stringify({ error: "title and summary are required" });
    }
    const state = await context.scenarioHostStateStore.update(
      context.lastMessage.sessionId,
      (current: ScenarioHostSessionState) => {
        const id = getStringArg(args, "id") || `journal-${current.turnIndex}-${current.journal.length + 1}`;
        const nextEntry: ScenarioHostJournalEntry = {
          id,
          turnIndex: current.turnIndex,
          title,
          summary,
          entityIds: getStringArrayArg(args, "entityIds") ?? [],
          tags: getStringArrayArg(args, "tags") ?? [],
          createdAtMs: Date.now()
        };
        return { ...current, journal: [...current.journal.filter((entry) => entry.id !== id), nextEntry] };
      },
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_journal_appended");
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
        loreEntries: current.loreEntries.some((entry) => entry.content === fact)
          ? current.loreEntries
          : [...current.loreEntries, createLoreEntryFromFact(fact, current.turnIndex, current.loreEntries.length)]
      }),
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_world_fact_appended");
    return JSON.stringify(state);
  }
};

function upsertBy<T>(items: T[], nextItem: T, predicate: (item: T) => boolean): T[] {
  const index = items.findIndex(predicate);
  if (index < 0) {
    return [...items, nextItem];
  }
  const nextItems = [...items];
  nextItems[index] = nextItem;
  return nextItems;
}

function isScenarioEntityKind(value: string): value is ScenarioHostEntity["kind"] {
  return value === "npc" || value === "location" || value === "faction" || value === "item" || value === "organization" || value === "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function mergeMechanics(
  current: ScenarioHostSessionState["mechanics"],
  patch: Record<string, unknown>
): ScenarioHostSessionState["mechanics"] {
  const ruleStyle = typeof patch.ruleStyle === "string" && (patch.ruleStyle === "freeform" || patch.ruleStyle === "light_checks" || patch.ruleStyle === "dice")
    ? patch.ruleStyle
    : current.ruleStyle;
  return {
    ruleStyle,
    dicePolicy: typeof patch.dicePolicy === "string" ? patch.dicePolicy.trim() : current.dicePolicy,
    difficultyScale: typeof patch.difficultyScale === "string" ? patch.difficultyScale.trim() : current.difficultyScale,
    successStates: Array.isArray(patch.successStates)
      ? patch.successStates.map((item) => String(item ?? "").trim()).filter(Boolean)
      : current.successStates
  };
}

function createLoreEntryFromFact(fact: string, turnIndex: number, index: number): ScenarioHostLoreEntry {
  return {
    id: `fact-${Date.now()}-${index + 1}`,
    title: `世界事实 ${index + 1}`,
    content: fact,
    tags: [],
    activationKeys: [],
    enabled: true,
    priority: 100,
    createdAtTurn: turnIndex,
    updatedAtTurn: turnIndex
  };
}
