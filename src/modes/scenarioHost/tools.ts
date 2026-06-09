import type { ToolDescriptor, ToolHandler } from "#llm/tools/core/shared.ts";
import { getBooleanArg, getNumberArg, getStringArg, getStringArrayArg } from "#llm/tools/core/toolArgHelpers.ts";
import { keepRawUnlessLargePolicy, stateChangePolicy } from "#llm/tools/core/resultObservationPresets.ts";
import { scenarioSetupOptionalItemKeys } from "#modes/scenarioHost/types.ts";
import type {
  ScenarioHostEntity,
  ScenarioHostHeldItem,
  ScenarioHostJournalEntry,
  ScenarioHostLoreEntry,
  ScenarioHostNpc,
  ScenarioHostObjective,
  ScenarioHostRelation,
  ScenarioSetupOptionalItemKey,
  ScenarioHostSessionState,
  ScenarioHostWornItem
} from "#modes/scenarioHost/types.ts";
import { resolveSessionParticipantLabel, resolveSessionParticipantRef } from "#conversation/session/sessionIdentity.ts";

type ScenarioToolContext = Parameters<ToolHandler>[2];

function ensureScenarioHostMode(context: ScenarioToolContext): string | null {
  const modeId = context.sessionManager.getModeId(context.lastMessage.sessionId);
  return modeId === "scenario_host" ? null : JSON.stringify({ error: "Current session is not using scenario_host mode" });
}

function getScenarioDefaults(context: ScenarioToolContext) {
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
        description: "更新当前 scenario_host 场景的受控字段，不可整体覆写完整状态。currentSituation 和 sceneSummary 应写成可主持的具体局面描述，通常 1-3 句，不要只填短标签。",
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
        name: "set_scenario_setup_optional_item_status",
        description: "记录或撤销 Scenario 初始化/配置中某个可选项被 owner 明确跳过。只有 owner 明确表示不填、暂无、跳过或同义表达时，才把 skipped 设为 true；如果后续已补充该项，设为 false。",
        parameters: {
          type: "object",
          properties: {
            item: { type: "string", enum: [...scenarioSetupOptionalItemKeys] },
            skipped: { type: "boolean" }
          },
          required: ["item", "skipped"],
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
        name: "update_player_character",
        description: "更新玩家自己的角色资料。初始化/资料阶段只有 owner 本轮消息明确说这是“我的角色/玩家角色/我扮演的角色/PC”时才使用；归属不明的角色卡不要写入玩家角色，先询问这是玩家角色还是 NPC。basicInfo、characterDescription、wornItems、heldItems 是玩家角色初始化必填信息；statusDescription 只记录当前临时状态。描述字段应具体到可主持、可表演，不要只填年龄、职业、物品名等短标签。",
        parameters: {
          type: "object",
          properties: {
            basicInfo: { type: "string" },
            characterDescription: { type: "string" },
            wornItems: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  wearPosition: { type: "string" },
                  description: { type: "string" }
                },
                required: ["name", "wearPosition", "description"],
                additionalProperties: false
              }
            },
            heldItems: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  quantity: { type: "number" }
                },
                required: ["name", "description"],
                additionalProperties: false
              }
            },
            statusDescription: { type: "string" }
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
        name: "manage_npc",
        description: "新增、更新或删除 NPC。创建 NPC 必须提供 basicInfo、characterDescription、wornItems 和 heldItems；statusDescription 是可选临时状态。basicInfo/characterDescription 要包含可表演的外观、气质、行为倾向或互动钩子；穿着和持有物描述要足够具体。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "update", "remove"] },
            id: { type: "string" },
            name: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
            basicInfo: { type: "string" },
            characterDescription: { type: "string" },
            wornItems: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  wearPosition: { type: "string" },
                  description: { type: "string" }
                },
                required: ["name", "wearPosition", "description"],
                additionalProperties: false
              }
            },
            heldItems: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  quantity: { type: "number" }
                },
                required: ["name", "description"],
                additionalProperties: false
              }
            },
            statusDescription: { type: "string" },
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
        name: "manage_lore_entry",
        description: "新增、更新或删除当前会话的 Lore 条目。用于长期世界信息、地点规则、伏笔和可被关键词激活的设定。content 应写成足够明确的可引用设定，通常 1-3 句，不要只填标题式短语。",
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
        description: "新增、更新或删除当前会话中的非角色实体，例如地点、阵营、场景物品、组织或其他对象。NPC 必须使用 manage_npc；角色随身持有物写入角色 heldItems。summary/status 应说明当前可感知状态、用途或与局势的关系，不要只填名称或类别。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["upsert", "remove"] },
            id: { type: "string" },
            kind: { type: "string", enum: ["location", "faction", "item", "organization", "other"] },
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
        description: "新增、更新或删除当前会话中两个角色或实体之间的关系。",
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
        description: "追加一条剧情日志，记录本轮或关键节点已经发生的事实。entityIds 可引用玩家、NPC 或其他实体 id。summary 应概括具体变化、后果或已确认线索，不要只写事件名。",
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
        name: "suggest_scenario_details",
        description: "调用低成本结构化建议器，为 Scenario 数据生成可编辑候选。当前支持 task=character_equipment，用于根据角色描述补全穿着和持有物。",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string", enum: ["character_equipment"] },
            subjectKind: { type: "string", enum: ["player", "npc", "other"] },
            name: { type: "string" },
            basicInfo: { type: "string" },
            description: { type: "string" },
            setting: { type: "string" },
            constraints: { type: "string" },
            wornItemCount: { type: "number" },
            heldItemCount: { type: "number" }
          },
          required: ["task", "description"],
          additionalProperties: false
        }
      }
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
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
    const rawFlags = getRawArg(args, "flags");
    const rawMechanics = getRawArg(args, "mechanics");
    const flags: Record<string, string | number | boolean> | undefined = isRecord(rawFlags)
      ? Object.fromEntries(
          Object.entries(rawFlags)
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

  async set_scenario_setup_optional_item_status(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const item = getStringArg(args, "item").trim();
    if (!isScenarioSetupOptionalItemKey(item)) {
      return JSON.stringify({ error: `item must be one of: ${scenarioSetupOptionalItemKeys.join(", ")}` });
    }
    const skipped = getBooleanArg(args, "skipped");
    if (skipped == null) {
      return JSON.stringify({ error: "skipped is required" });
    }
    const state = await context.scenarioHostStateStore.update(
      context.lastMessage.sessionId,
      (current: ScenarioHostSessionState) => {
        const currentItems = new Set(current.setupProgress?.skippedOptionalItems ?? []);
        if (skipped) {
          currentItems.add(item);
        } else {
          currentItems.delete(item);
        }
        return {
          ...current,
          setupProgress: {
            ...current.setupProgress,
            skippedOptionalItems: [...currentItems]
          }
        };
      },
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_setup_optional_item_status_updated");
    return JSON.stringify(state);
  },

  async update_player_character(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const wornItems = getWornItemsArg(args, "wornItems");
    const heldItems = getHeldItemsArg(args, "heldItems");
    const state = await context.scenarioHostStateStore.update(
      context.lastMessage.sessionId,
      (current: ScenarioHostSessionState) => ({
        ...current,
        player: {
          ...current.player,
          ...getStringPatch(args, "basicInfo"),
          ...getStringPatch(args, "characterDescription"),
          ...(wornItems ? { wornItems } : {}),
          ...(heldItems ? { heldItems } : {}),
          ...getStringPatch(args, "statusDescription")
        }
      }),
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_player_updated");
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
        return {
          ...current,
          objectives: upsertBy(current.objectives, nextObjective, (item) => item.id === id)
        };
      },
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_objective_updated");
    return JSON.stringify(state);
  },

  async manage_npc(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const action = getStringArg(args, "action").trim();
    const id = getStringArg(args, "id").trim();
    if (!action || !id) {
      return JSON.stringify({ error: "action and id are required" });
    }
    if (action !== "create" && action !== "update" && action !== "remove") {
      return JSON.stringify({ error: "action must be create, update, or remove" });
    }

    let nextNpc: ScenarioHostNpc | null = null;
    if (action === "create") {
      const createError = validateNpcCreateArgs(args);
      if (createError) {
        return JSON.stringify({ error: createError });
      }
      nextNpc = buildNpcFromArgs(args, id, undefined);
    }
    if (action === "update") {
      const current = await context.scenarioHostStateStore.ensure(context.lastMessage.sessionId, getScenarioDefaults(context));
      const existing = current.npcs.find((entry) => entry.id === id);
      if (!existing) {
        return JSON.stringify({ error: `npc_not_found: ${id}` });
      }
      nextNpc = buildNpcFromArgs(args, id, existing);
    }
    if (action === "remove") {
      const state = await context.scenarioHostStateStore.update(
        context.lastMessage.sessionId,
        (current: ScenarioHostSessionState) => {
          return { ...current, npcs: current.npcs.filter((entry) => entry.id !== id) };
        },
        getScenarioDefaults(context)
      );
      context.persistSession?.(context.lastMessage.sessionId, "scenario_host_npc_updated");
      return JSON.stringify(state);
    }
    if (!nextNpc) {
      return JSON.stringify({ error: `invalid NPC ${action} payload: name, basicInfo, characterDescription, wornItems, and heldItems are required` });
    }

    const state = await context.scenarioHostStateStore.update(
      context.lastMessage.sessionId,
      (current: ScenarioHostSessionState) => ({
        ...current,
        npcs: upsertBy(current.npcs, nextNpc, (entry) => entry.id === id)
      }),
      getScenarioDefaults(context)
    );
    context.persistSession?.(context.lastMessage.sessionId, "scenario_host_npc_updated");
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
    if (getStringArg(args, "kind") === "npc") {
      return JSON.stringify({ error: "NPC must be managed with manage_npc" });
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

  async suggest_scenario_details(_toolCall, args, context) {
    const denied = ensureScenarioHostMode(context);
    if (denied) {
      return denied;
    }
    const task = getStringArg(args, "task");
    if (task !== "character_equipment") {
      return JSON.stringify({ error: "unsupported scenario suggestion task" });
    }
    if (!context.structuredSuggestionService?.isEnabled()) {
      return JSON.stringify({ error: "structured_suggestion_model_not_configured" });
    }
    const description = getStringArg(args, "description");
    if (!description) {
      return JSON.stringify({ error: "description is required" });
    }
    const result = await context.structuredSuggestionService.suggestObject({
      taskName: "scenario.character_equipment",
      instruction: "根据角色资料生成可编辑的穿着清单和持有物清单。不要输出角色设定正文，只输出装备建议。",
      context: {
        subjectKind: getStringArg(args, "subjectKind") || "other",
        name: getStringArg(args, "name"),
        basicInfo: getStringArg(args, "basicInfo"),
        description,
        setting: getStringArg(args, "setting"),
        constraints: getStringArg(args, "constraints"),
        wornItemCount: Math.max(1, Math.round(getNumberArg(args, "wornItemCount") ?? 4)),
        heldItemCount: Math.max(1, Math.round(getNumberArg(args, "heldItemCount") ?? 2))
      },
      outputContract: JSON.stringify({
        wornItems: [{ name: "string", wearPosition: "string", description: "string" }],
        heldItems: [{ name: "string", description: "string", quantity: 1 }]
      }),
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
    });
    if (!result.ok) {
      return JSON.stringify({
        ok: false,
        error: result.error ?? "structured_suggestion_failed",
        modelRef: result.modelRef
      });
    }
    return JSON.stringify({
      ok: true,
      modelRef: result.modelRef,
      wornItems: normalizeWornItems(result.value.wornItems),
      heldItems: normalizeHeldItems(result.value.heldItems)
    });
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
  return value === "location" || value === "faction" || value === "item" || value === "organization" || value === "other";
}

function isScenarioSetupOptionalItemKey(value: string): value is ScenarioSetupOptionalItemKey {
  return (scenarioSetupOptionalItemKeys as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function getRawArg(args: unknown, key: string): unknown {
  return isRecord(args) && key in args ? args[key] : undefined;
}

function hasArg(args: unknown, key: string): boolean {
  return isRecord(args) && key in args;
}

function getStringPatch(args: unknown, key: string): Partial<Record<string, string>> {
  if (!isRecord(args) || !(key in args)) {
    return {};
  }
  return { [key]: String(args[key] ?? "").trim() };
}

function getWornItemsArg(args: unknown, key: string): ScenarioHostWornItem[] | undefined {
  if (!isRecord(args) || !(key in args)) {
    return undefined;
  }
  return normalizeWornItems(args[key]);
}

function getHeldItemsArg(args: unknown, key: string): ScenarioHostHeldItem[] | undefined {
  if (!isRecord(args) || !(key in args)) {
    return undefined;
  }
  return normalizeHeldItems(args[key]);
}

function normalizeWornItems(value: unknown): ScenarioHostWornItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): ScenarioHostWornItem[] => {
    if (!isRecord(item)) {
      return [];
    }
    const name = String(item.name ?? "").trim();
    const wearPosition = String(item.wearPosition ?? "").trim();
    const description = String(item.description ?? "").trim();
    return name && wearPosition && description
      ? [{ name, wearPosition, description }]
      : [];
  });
}

function normalizeHeldItems(value: unknown): ScenarioHostHeldItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): ScenarioHostHeldItem[] => {
    if (!isRecord(item)) {
      return [];
    }
    const name = String(item.name ?? "").trim();
    const description = String(item.description ?? "").trim();
    const quantity = Math.max(1, Math.round(Number(item.quantity ?? 1)));
    return name && description
      ? [{ name, description, quantity: Number.isFinite(quantity) ? quantity : 1 }]
      : [];
  });
}

function validateNpcCreateArgs(args: unknown): string | null {
  const missing: string[] = [];
  if (!getStringArg(args, "name")) {
    missing.push("name");
  }
  if (!getStringArg(args, "basicInfo")) {
    missing.push("basicInfo");
  }
  if (!getStringArg(args, "characterDescription")) {
    missing.push("characterDescription");
  }
  const wornItems = getWornItemsArg(args, "wornItems");
  if (!wornItems || wornItems.length === 0) {
    missing.push("wornItems");
  }
  const heldItems = getHeldItemsArg(args, "heldItems");
  if (!heldItems || heldItems.length === 0) {
    missing.push("heldItems");
  }
  return missing.length > 0 ? `missing required NPC fields: ${missing.join(", ")}` : null;
}

function buildNpcFromArgs(args: unknown, id: string, existing: ScenarioHostNpc | undefined): ScenarioHostNpc | null {
  const wornItems = getWornItemsArg(args, "wornItems");
  const heldItems = getHeldItemsArg(args, "heldItems");
  const name = getStringArg(args, "name") || existing?.name || "";
  const basicInfo = getStringArg(args, "basicInfo") || existing?.basicInfo || "";
  const characterDescription = getStringArg(args, "characterDescription") || existing?.characterDescription || "";
  const nextWornItems = wornItems ?? existing?.wornItems ?? [];
  const nextHeldItems = heldItems ?? existing?.heldItems ?? [];
  if (!name || !basicInfo || !characterDescription || nextWornItems.length === 0 || nextHeldItems.length === 0) {
    return null;
  }
  return {
    id,
    name,
    aliases: getStringArrayArg(args, "aliases") ?? existing?.aliases ?? [],
    basicInfo,
    characterDescription,
    wornItems: nextWornItems,
    heldItems: nextHeldItems,
    statusDescription: hasArg(args, "statusDescription") ? getStringArg(args, "statusDescription") : existing?.statusDescription ?? "",
    locationId: getStringArg(args, "locationId") || existing?.locationId || null,
    tags: getStringArrayArg(args, "tags") ?? existing?.tags ?? [],
    notes: hasArg(args, "notes") ? getStringArg(args, "notes") : existing?.notes ?? ""
  };
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
