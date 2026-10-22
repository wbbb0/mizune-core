import { randomUUID } from "node:crypto";
import type { ToolDescriptor, ToolHandler } from "#llm/tools/core/shared.ts";

function nanoid(len = 8): string {
  return randomUUID().replace(/-/g, "").slice(0, len);
}
import { keepRawUnlessLargePolicy, stateChangePolicy } from "#llm/tools/core/resultObservationPresets.ts";
import {
  applyDeterministicTimeTick,
  clamp,
  deriveClockFields,
  parseDisplayClockToIso
} from "./clockAndRules.ts";
import {
  statefulRpActivityKinds,
  statefulRpBodyPartKeys,
  statefulRpClothingItemSchema,
  statefulRpIntimateGearSchema,
  statefulRpJournalEntrySchema,
  statefulRpPromiseSchema,
  statefulRpRelationshipStages,
  statefulRpScheduleEntrySchema,
  type StatefulRpActivityKind,
  type StatefulRpBodyPartKey,
  type StatefulRpClothingItem,
  type StatefulRpIntimateGear,
  type StatefulRpSessionState
} from "./types.ts";

type StatefulRpToolContext = Parameters<ToolHandler>[2];

function ensureStatefulRpMode(context: StatefulRpToolContext): string | null {
  const modeId = context.sessionManager.getModeId(context.lastMessage.sessionId);
  if (modeId !== "stateful_rp") {
    return JSON.stringify({ error: "当前会话未启用 stateful_rp 模式" });
  }
  if (!context.statefulRpStateStore) {
    return JSON.stringify({ error: "statefulRpStateStore 未初始化" });
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const statefulRpToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "stateful_rp_init",
        description: "初始化或重设当前 stateful_rp 会话的开局状态，包括初始时间、地点、全身各层穿戴（内衣、袜品、外衣、鞋履等）、私密配饰、生理指标、初始心境与关系阶段。",
        parameters: {
          type: "object",
          properties: {
            clock: {
              type: "string",
              description: "初始时间，支持 'YYYY-MM-DD HH:mm' 或 ISO 时间字符串"
            },
            currentLocation: { type: "string", description: "初始所在地点" },
            locationTags: {
              type: "array",
              items: { type: "string" },
              description: "地点环境标签，例如 ['室内', '私密', '卧室'] 或 ['户外', '闷热', '公共场所']"
            },
            weather: { type: "string", description: "天气与环境温度描述" },
            isSeparated: { type: "boolean", description: "开局双方是否处于异地分开状态" },
            ambientPressure: { type: "string", description: "周边环境氛围或压力说明" },
            outfitPresetName: { type: "string", description: "穿搭整体名称，例如 '日常通勤黑丝OL装'、'居家宽松睡裙'" },
            outfitItems: {
              type: "array",
              description: "全身穿戴单品列表（建议完整列出 bra/underwear/hosiery/top/bottom/dress/outerwear/footwear/accessory）",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  slot: {
                    type: "string",
                    enum: ["bra", "underwear", "hosiery", "top", "bottom", "dress", "outerwear", "footwear", "accessory"]
                  },
                  layer: {
                    type: "string",
                    enum: ["intimate", "base", "mid", "outer", "footwear", "accessory"]
                  },
                  name: { type: "string" },
                  material: { type: "string" },
                  fit: { type: "string", enum: ["tight", "fitted", "loose", "sheer", "binding"] },
                  breathability: { type: "number", description: "透气性 0~100（丝袜/紧身皮质等较低，纯棉宽松较高）" },
                  wornMinutes: { type: "number", description: "开局时已经穿戴的分钟数" },
                  conditionNote: { type: "string" }
                },
                required: ["slot", "name"]
              }
            },
            intimateGear: {
              type: "array",
              description: "开局已穿戴的私密/情趣道具列表（如无可省略）",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  position: { type: "string" },
                  intensity: { type: "number" },
                  concealed: { type: "boolean" },
                  wornMinutes: { type: "number" },
                  effectNote: { type: "string" }
                },
                required: ["name", "position"]
              }
            },
            makeupAndHair: { type: "string" },
            postureAndDemeanor: { type: "string" },
            primaryEmotion: { type: "string" },
            surfaceDemeanor: { type: "string" },
            innerMonologue: { type: "string" },
            relationshipStage: {
              type: "string",
              enum: [...statefulRpRelationshipStages]
            },
            intimacy: { type: "number" },
            trust: { type: "number" },
            affection: { type: "number" },
            dominanceBalance: { type: "number", description: "-100(完全顺从) ~ +100(完全主导)" },
            comfortLevel: { type: "string" },
            summary: { type: "string", description: "初始化状态备注，将记入日志" }
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
        name: "stateful_rp_update_embodiment",
        description: "当发生显式的身体、穿戴、私密道具或生理动作（如主动换装、脱衣、撩起裙摆、穿戴/调整道具、洗澡清洁、如厕、进食休息、直接身体接触导致局部感官突变）时更新角色身体与服饰状态。",
        parameters: {
          type: "object",
          properties: {
            presetName: { type: "string", description: "更新穿搭主题名称" },
            replaceOutfitItems: {
              type: "array",
              description: "整套替换全身穿戴列表（如彻底换装）",
              items: { type: "object", additionalProperties: true }
            },
            upsertOutfitItems: {
              type: "array",
              description: "新增或局部修改某几件穿戴单品（按 id 或 slot 匹配更新，例如修改 displacement 为 pulled_aside / unfastened / half_off，或更新 wetness / odorNote / conditionNote）",
              items: { type: "object", additionalProperties: true }
            },
            removeOutfitSlotsOrIds: {
              type: "array",
              items: { type: "string" },
              description: "脱下或移除的衣物 id 或 slot 名称"
            },
            replaceIntimateGear: {
              type: "array",
              description: "替换当前穿戴的私密/情趣道具列表（传空数组表示全部取下）",
              items: { type: "object", additionalProperties: true }
            },
            overallImpact: { type: "string", description: "穿戴与道具对全身的综合感官影响总结" },
            bathedAndCleaned: {
              type: "boolean",
              description: "若为 true，表示刚洗完澡/彻底清洁：清洁度恢复至 95，清除衣物与私密部位的汗湿与分泌物残留"
            },
            relievedBladder: {
              type: "boolean",
              description: "若为 true，表示刚去过洗手间，bladder 归零"
            },
            vitalsPatch: {
              type: "object",
              description: "直接覆写或微调生理指标（0~100）",
              properties: {
                stamina: { type: "number" },
                energy: { type: "number" },
                hygiene: { type: "number" },
                hunger: { type: "number" },
                thirst: { type: "number" },
                bladder: { type: "number" },
                temperature: { type: "string", enum: ["chilly", "cool", "comfortable", "warm", "hot", "feverish"] },
                heartRate: { type: "string", enum: ["calm", "elevated", "racing", "pounding"] },
                statusEffects: { type: "array", items: { type: "string" } }
              },
              additionalProperties: false
            },
            appearancePatch: {
              type: "object",
              properties: {
                makeupAndHair: { type: "string" },
                postureAndDemeanor: { type: "string" },
                observable: { type: "array", items: { type: "string" } }
              },
              additionalProperties: false
            },
            partSensationsPatch: {
              type: "object",
              description: "按身体部位（head_neck, chest, waist_belly, groin_hips, thighs_legs, feet）更新体感、外观、气味与显著度",
              additionalProperties: {
                type: "object",
                properties: {
                  sensation: { type: "string" },
                  appearanceNote: { type: "string" },
                  scentNote: { type: "string" },
                  sensitivity: { type: "number" },
                  salience: { type: "number" }
                },
                additionalProperties: false
              }
            },
            intimateStatePatch: {
              type: "object",
              properties: {
                lubrication: { type: "number" },
                muscleTension: { type: "number" },
                lingeringSimulation: { type: "string" },
                secretionNote: { type: "string" }
              },
              additionalProperties: false
            },
            reason: { type: "string", description: "本次身体/服饰变更原因，将记入状态日志" }
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
        name: "stateful_rp_update_mind_and_relation",
        description: "当发生明显的情绪转折、内心防线动摇、情欲/羞耻激增、短期意图变化、关系阶段突破或立下/完成约定时，更新角色心理与关系状态。",
        parameters: {
          type: "object",
          properties: {
            emotionPatch: {
              type: "object",
              properties: {
                primary: { type: "string" },
                secondary: { type: "string" },
                valence: { type: "number", description: "-100 ~ +100" },
                arousal: { type: "number", description: "0 ~ 100" },
                selfControl: { type: "number", description: "0 ~ 100" },
                triggers: { type: "array", items: { type: "string" } }
              },
              additionalProperties: false
            },
            surfaceVsInnerPatch: {
              type: "object",
              properties: {
                surfaceDemeanor: { type: "string" },
                innerMonologue: { type: "string" },
                tension: { type: "number", description: "0 ~ 100" }
              },
              additionalProperties: false
            },
            desirePatch: {
              type: "object",
              properties: {
                arousal: { type: "number" },
                longing: { type: "number" },
                shame: { type: "number" },
                frustration: { type: "number" },
                focus: { type: "string" }
              },
              additionalProperties: false
            },
            intrusiveThoughts: {
              type: "array",
              items: { type: "string" },
              description: "当前难以克制的侵入性杂念或分心念头"
            },
            intentions: {
              type: "array",
              description: "更新当前短期微意图列表",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  goal: { type: "string" },
                  reason: { type: "string" },
                  priority: { type: "number" },
                  status: { type: "string", enum: ["active", "completed", "fulfilled", "abandoned"] }
                },
                required: ["goal"]
              }
            },
            relationshipPatch: {
              type: "object",
              properties: {
                stage: { type: "string", enum: [...statefulRpRelationshipStages] },
                intimacy: { type: "number" },
                trust: { type: "number" },
                affection: { type: "number" },
                respect: { type: "number" },
                dominanceBalance: { type: "number" },
                comfortLevel: { type: "string" },
                unresolvedFriction: { type: "number" },
                romanticTension: { type: "number" },
                jealousy: { type: "number" },
                recentAfterglow: { type: "string" }
              },
              additionalProperties: false
            },
            upsertPromise: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                dueClock: { type: "string", description: "截止时间 YYYY-MM-DD HH:mm 或 ISO" },
                status: { type: "string", enum: ["pending", "fulfilled", "broken", "overdue"] }
              },
              required: ["content"]
            },
            reason: { type: "string", description: "本次心理与关系变化摘要，将记入日志" }
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
        name: "stateful_rp_update_scene",
        description: "当发生地点移动、环境/天气变化、双方分开或重逢、日程增改，或剧情中明确跳过了一大段时间时更新世界与时间状态。",
        parameters: {
          type: "object",
          properties: {
            currentLocation: { type: "string" },
            locationTags: { type: "array", items: { type: "string" } },
            weather: { type: "string" },
            isSeparated: { type: "boolean", description: "双方是否处于分开/异地状态" },
            presentNpcs: { type: "array", items: { type: "string" } },
            ambientPressure: { type: "string" },
            advanceMinutes: {
              type: "number",
              description: "显式推进的游戏内分钟数（仅当剧情明确跳过一段时间或 # 场外指令要求跳转时间时填写）"
            },
            setClock: {
              type: "string",
              description: "直接将时钟设定为指定时间（'YYYY-MM-DD HH:mm' 或 ISO，仅用于场外指令或明确时间跳跃）"
            },
            activityKind: {
              type: "string",
              enum: [...statefulRpActivityKinds],
              description: "这段时间内的主要活动类型"
            },
            upsertSchedule: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                startClock: { type: "string" },
                endClock: { type: "string" },
                location: { type: "string" },
                status: { type: "string", enum: ["pending", "completed", "missed", "cancelled"] }
              },
              required: ["title", "startClock", "endClock", "location"]
            },
            reason: { type: "string", description: "场景或时间变更说明" }
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
        name: "stateful_rp_inspect",
        description: "查看当前 stateful_rp 会话的详细 JSON 状态结构（可按分区过滤）。",
        parameters: {
          type: "object",
          properties: {
            section: {
              type: "string",
              enum: ["all", "embodiment", "mind", "relationship", "world", "journal", "maintenanceLog"],
              description: "要查看的分区，默认为 all"
            }
          },
          additionalProperties: false
        }
      }
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
  }
];

export const statefulRpToolHandlers: Record<string, ToolHandler> = {
  async stateful_rp_init(_toolCall, args, context) {
    const denied = ensureStatefulRpMode(context);
    if (denied) {
      return denied;
    }
    const payload = isRecord(args) ? args : {};
    const state = await context.statefulRpStateStore!.update(
      context.lastMessage.sessionId,
      (current) => {
        const next: StatefulRpSessionState = structuredClone(current);
        next.initialized = true;

        if (typeof payload.clock === "string" && payload.clock.trim()) {
          const parsedIso = parseDisplayClockToIso(payload.clock, current.clock.timezone);
          if (parsedIso) {
            const derived = deriveClockFields(parsedIso);
            next.clock.currentIso = derived.currentIso;
            next.clock.dayOfWeek = derived.dayOfWeek;
            next.clock.timeOfDay = derived.timeOfDay;
          }
        }

        if (typeof payload.currentLocation === "string" && payload.currentLocation.trim()) {
          next.world.currentLocation = payload.currentLocation.trim();
        }
        if (Array.isArray(payload.locationTags)) {
          next.world.locationTags = payload.locationTags.map((item) => String(item ?? "").trim()).filter(Boolean);
        }
        if (typeof payload.weather === "string" && payload.weather.trim()) {
          next.world.weather = payload.weather.trim();
        }
        if (typeof payload.isSeparated === "boolean") {
          next.world.isSeparated = payload.isSeparated;
        }
        if (typeof payload.ambientPressure === "string") {
          next.world.ambientPressure = payload.ambientPressure.trim();
        }

        if (typeof payload.outfitPresetName === "string" && payload.outfitPresetName.trim()) {
          next.embodiment.outfit.presetName = payload.outfitPresetName.trim();
        }
        if (Array.isArray(payload.outfitItems)) {
          next.embodiment.outfit.items = normalizeClothingItems(payload.outfitItems);
        }
        if (Array.isArray(payload.intimateGear)) {
          next.embodiment.outfit.intimateGear = normalizeIntimateGear(payload.intimateGear);
        }

        if (typeof payload.makeupAndHair === "string" && payload.makeupAndHair.trim()) {
          next.embodiment.appearance.makeupAndHair = payload.makeupAndHair.trim();
        }
        if (typeof payload.postureAndDemeanor === "string" && payload.postureAndDemeanor.trim()) {
          next.embodiment.appearance.postureAndDemeanor = payload.postureAndDemeanor.trim();
        }

        if (typeof payload.primaryEmotion === "string" && payload.primaryEmotion.trim()) {
          next.mind.emotion.primary = payload.primaryEmotion.trim();
        }
        if (typeof payload.surfaceDemeanor === "string" && payload.surfaceDemeanor.trim()) {
          next.mind.surfaceVsInner.surfaceDemeanor = payload.surfaceDemeanor.trim();
        }
        if (typeof payload.innerMonologue === "string" && payload.innerMonologue.trim()) {
          next.mind.surfaceVsInner.innerMonologue = payload.innerMonologue.trim();
        }

        if (typeof payload.relationshipStage === "string" && (statefulRpRelationshipStages as readonly string[]).includes(payload.relationshipStage)) {
          next.relationship.stage = payload.relationshipStage as StatefulRpSessionState["relationship"]["stage"];
        }
        if (typeof payload.intimacy === "number") {
          next.relationship.intimacy = clamp(payload.intimacy, 0, 100);
        }
        if (typeof payload.trust === "number") {
          next.relationship.trust = clamp(payload.trust, 0, 100);
        }
        if (typeof payload.affection === "number") {
          next.relationship.affection = clamp(payload.affection, 0, 100);
        }
        if (typeof payload.dominanceBalance === "number") {
          next.relationship.dominanceBalance = clamp(payload.dominanceBalance, -100, 100);
        }
        if (typeof payload.comfortLevel === "string" && payload.comfortLevel.trim()) {
          next.relationship.boundaries.comfortLevel = payload.comfortLevel.trim();
        }

        const summary = typeof payload.summary === "string" && payload.summary.trim()
          ? payload.summary.trim()
          : `完成开局状态初始化（地点：${next.world.currentLocation}，穿搭：${next.embodiment.outfit.presetName}）`;
        next.journal.push(statefulRpJournalEntrySchema.parse({
          id: nanoid(8),
          clockIso: next.clock.currentIso,
          category: "world",
          summary
        }));
        return next;
      }
    );
    context.persistSession?.(context.lastMessage.sessionId, "stateful_rp_initialized");
    return JSON.stringify({ ok: true, state });
  },

  async stateful_rp_update_embodiment(_toolCall, args, context) {
    const denied = ensureStatefulRpMode(context);
    if (denied) {
      return denied;
    }
    const payload = isRecord(args) ? args : {};
    const state = await context.statefulRpStateStore!.update(
      context.lastMessage.sessionId,
      (current) => {
        const next: StatefulRpSessionState = structuredClone(current);
        next.initialized = true;

        if (typeof payload.presetName === "string" && payload.presetName.trim()) {
          next.embodiment.outfit.presetName = payload.presetName.trim();
        }
        if (Array.isArray(payload.replaceOutfitItems)) {
          next.embodiment.outfit.items = normalizeClothingItems(payload.replaceOutfitItems);
        }
        if (Array.isArray(payload.removeOutfitSlotsOrIds) && payload.removeOutfitSlotsOrIds.length > 0) {
          const removeSet = new Set(payload.removeOutfitSlotsOrIds.map((v) => String(v ?? "").trim()));
          next.embodiment.outfit.items = next.embodiment.outfit.items.filter(
            (item) => !removeSet.has(item.id) && !removeSet.has(item.slot) && !removeSet.has(item.name)
          );
        }
        if (Array.isArray(payload.upsertOutfitItems)) {
          for (const rawItem of payload.upsertOutfitItems) {
            if (!isRecord(rawItem)) {
              continue;
            }
            const idArg = typeof rawItem.id === "string" ? rawItem.id.trim() : "";
            const slotArg = typeof rawItem.slot === "string" ? rawItem.slot.trim() : "";
            const existingIndex = next.embodiment.outfit.items.findIndex(
              (item) => (idArg && item.id === idArg) || (slotArg && item.slot === slotArg)
            );
            if (existingIndex >= 0) {
              const existing = next.embodiment.outfit.items[existingIndex]!;
              next.embodiment.outfit.items[existingIndex] = mergeClothingItem(existing, rawItem);
            } else {
              const created = normalizeClothingItems([rawItem])[0];
              if (created) {
                next.embodiment.outfit.items.push(created);
              }
            }
          }
        }
        if (Array.isArray(payload.replaceIntimateGear)) {
          next.embodiment.outfit.intimateGear = normalizeIntimateGear(payload.replaceIntimateGear);
        }
        if (typeof payload.overallImpact === "string") {
          next.embodiment.outfit.overallImpact = payload.overallImpact.trim();
        }

        if (payload.bathedAndCleaned === true) {
          next.embodiment.vitals.hygiene = 95;
          next.embodiment.intimateState.secretionNote = "";
          for (const item of next.embodiment.outfit.items) {
            item.wornMinutes = 0;
            item.wetness = 0;
            item.secretionStain = 0;
            item.odorIntensity = 0;
            item.odorNote = "刚洗净或换上的清新织物气息";
            item.comfort = 90;
          }
          for (const key of statefulRpBodyPartKeys) {
            next.embodiment.partSensations[key].scentNote = "沐浴后的清爽皂香";
            next.embodiment.partSensations[key].sensation = "刚洗完澡的温热清爽感";
            next.embodiment.partSensations[key].salience = Math.min(20, next.embodiment.partSensations[key].salience);
          }
        }
        if (payload.relievedBladder === true) {
          next.embodiment.vitals.bladder = 0;
        }

        if (isRecord(payload.vitalsPatch)) {
          const vp = payload.vitalsPatch;
          if (typeof vp.stamina === "number") next.embodiment.vitals.stamina = clamp(vp.stamina, 0, 100);
          if (typeof vp.energy === "number") next.embodiment.vitals.energy = clamp(vp.energy, 0, 100);
          if (typeof vp.hygiene === "number") next.embodiment.vitals.hygiene = clamp(vp.hygiene, 0, 100);
          if (typeof vp.hunger === "number") next.embodiment.vitals.hunger = clamp(vp.hunger, 0, 100);
          if (typeof vp.thirst === "number") next.embodiment.vitals.thirst = clamp(vp.thirst, 0, 100);
          if (typeof vp.bladder === "number") next.embodiment.vitals.bladder = clamp(vp.bladder, 0, 100);
          if (typeof vp.temperature === "string" && ["chilly", "cool", "comfortable", "warm", "hot", "feverish"].includes(vp.temperature)) {
            next.embodiment.vitals.temperature = vp.temperature as StatefulRpSessionState["embodiment"]["vitals"]["temperature"];
          }
          if (typeof vp.heartRate === "string" && ["calm", "elevated", "racing", "pounding"].includes(vp.heartRate)) {
            next.embodiment.vitals.heartRate = vp.heartRate as StatefulRpSessionState["embodiment"]["vitals"]["heartRate"];
          }
          if (Array.isArray(vp.statusEffects)) {
            next.embodiment.vitals.statusEffects = vp.statusEffects.map((item) => String(item ?? "").trim()).filter(Boolean);
          }
        }

        if (isRecord(payload.appearancePatch)) {
          const ap = payload.appearancePatch;
          if (typeof ap.makeupAndHair === "string") next.embodiment.appearance.makeupAndHair = ap.makeupAndHair.trim();
          if (typeof ap.postureAndDemeanor === "string") next.embodiment.appearance.postureAndDemeanor = ap.postureAndDemeanor.trim();
          if (Array.isArray(ap.observable)) {
            next.embodiment.appearance.observable = ap.observable.map((item) => String(item ?? "").trim()).filter(Boolean);
          }
        }

        if (isRecord(payload.partSensationsPatch)) {
          for (const key of statefulRpBodyPartKeys) {
            const patch = payload.partSensationsPatch[key];
            if (!isRecord(patch)) {
              continue;
            }
            const target = next.embodiment.partSensations[key];
            if (typeof patch.sensation === "string") target.sensation = patch.sensation.trim();
            if (typeof patch.appearanceNote === "string") target.appearanceNote = patch.appearanceNote.trim();
            if (typeof patch.scentNote === "string") target.scentNote = patch.scentNote.trim();
            if (typeof patch.sensitivity === "number") target.sensitivity = clamp(patch.sensitivity, 0, 100);
            if (typeof patch.salience === "number") target.salience = clamp(patch.salience, 0, 100);
          }
        }

        if (isRecord(payload.intimateStatePatch)) {
          const ip = payload.intimateStatePatch;
          if (typeof ip.lubrication === "number") next.embodiment.intimateState.lubrication = clamp(ip.lubrication, 0, 100);
          if (typeof ip.muscleTension === "number") next.embodiment.intimateState.muscleTension = clamp(ip.muscleTension, 0, 100);
          if (typeof ip.lingeringSimulation === "string") next.embodiment.intimateState.lingeringSimulation = ip.lingeringSimulation.trim();
          if (typeof ip.secretionNote === "string") next.embodiment.intimateState.secretionNote = ip.secretionNote.trim();
        }

        if (typeof payload.reason === "string" && payload.reason.trim()) {
          next.journal.push(statefulRpJournalEntrySchema.parse({
            id: nanoid(8),
            clockIso: next.clock.currentIso,
            category: "embodiment",
            summary: payload.reason.trim()
          }));
        }

        return next;
      }
    );
    context.persistSession?.(context.lastMessage.sessionId, "stateful_rp_embodiment_updated");
    return JSON.stringify({ ok: true, state });
  },

  async stateful_rp_update_mind_and_relation(_toolCall, args, context) {
    const denied = ensureStatefulRpMode(context);
    if (denied) {
      return denied;
    }
    const payload = isRecord(args) ? args : {};
    const state = await context.statefulRpStateStore!.update(
      context.lastMessage.sessionId,
      (current) => {
        const next: StatefulRpSessionState = structuredClone(current);
        next.initialized = true;

        if (isRecord(payload.emotionPatch)) {
          const ep = payload.emotionPatch;
          if (typeof ep.primary === "string" && ep.primary.trim()) next.mind.emotion.primary = ep.primary.trim();
          if (typeof ep.secondary === "string") next.mind.emotion.secondary = ep.secondary.trim();
          if (typeof ep.valence === "number") next.mind.emotion.valence = clamp(ep.valence, -100, 100);
          if (typeof ep.arousal === "number") next.mind.emotion.arousal = clamp(ep.arousal, 0, 100);
          if (typeof ep.selfControl === "number") next.mind.emotion.selfControl = clamp(ep.selfControl, 0, 100);
          if (Array.isArray(ep.triggers)) {
            next.mind.emotion.triggers = ep.triggers.map((item) => String(item ?? "").trim()).filter(Boolean);
          }
        }

        if (isRecord(payload.surfaceVsInnerPatch)) {
          const sp = payload.surfaceVsInnerPatch;
          if (typeof sp.surfaceDemeanor === "string") next.mind.surfaceVsInner.surfaceDemeanor = sp.surfaceDemeanor.trim();
          if (typeof sp.innerMonologue === "string") next.mind.surfaceVsInner.innerMonologue = sp.innerMonologue.trim();
          if (typeof sp.tension === "number") next.mind.surfaceVsInner.tension = clamp(sp.tension, 0, 100);
        }

        if (isRecord(payload.desirePatch)) {
          const dp = payload.desirePatch;
          if (typeof dp.arousal === "number") next.mind.desire.arousal = clamp(dp.arousal, 0, 100);
          if (typeof dp.longing === "number") next.mind.desire.longing = clamp(dp.longing, 0, 100);
          if (typeof dp.shame === "number") next.mind.desire.shame = clamp(dp.shame, 0, 100);
          if (typeof dp.frustration === "number") next.mind.desire.frustration = clamp(dp.frustration, 0, 100);
          if (typeof dp.focus === "string") next.mind.desire.focus = dp.focus.trim();
        }

        if (Array.isArray(payload.intrusiveThoughts)) {
          next.mind.intrusiveThoughts = payload.intrusiveThoughts.map((item) => String(item ?? "").trim()).filter(Boolean);
        }

        if (Array.isArray(payload.intentions)) {
          next.mind.intentions = payload.intentions
            .filter(isRecord)
            .map((item) => ({
              id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : nanoid(6),
              goal: String(item.goal ?? "").trim(),
              reason: String(item.reason ?? "").trim(),
              priority: clamp(Number(item.priority ?? 3), 1, 5),
              status: (item.status === "completed" || item.status === "fulfilled" || item.status === "abandoned"
                ? item.status
                : "active") as "active" | "completed" | "fulfilled" | "abandoned"
            }))
            .filter((item) => Boolean(item.goal));
        }

        if (isRecord(payload.relationshipPatch)) {
          const rp = payload.relationshipPatch;
          if (typeof rp.stage === "string" && (statefulRpRelationshipStages as readonly string[]).includes(rp.stage)) {
            next.relationship.stage = rp.stage as StatefulRpSessionState["relationship"]["stage"];
          }
          if (typeof rp.intimacy === "number") next.relationship.intimacy = clamp(rp.intimacy, 0, 100);
          if (typeof rp.trust === "number") next.relationship.trust = clamp(rp.trust, 0, 100);
          if (typeof rp.affection === "number") next.relationship.affection = clamp(rp.affection, 0, 100);
          if (typeof rp.respect === "number") next.relationship.respect = clamp(rp.respect, 0, 100);
          if (typeof rp.dominanceBalance === "number") next.relationship.dominanceBalance = clamp(rp.dominanceBalance, -100, 100);
          if (typeof rp.comfortLevel === "string") next.relationship.boundaries.comfortLevel = rp.comfortLevel.trim();
          if (typeof rp.unresolvedFriction === "number") next.relationship.tension.unresolvedFriction = clamp(rp.unresolvedFriction, 0, 100);
          if (typeof rp.romanticTension === "number") next.relationship.tension.romanticTension = clamp(rp.romanticTension, 0, 100);
          if (typeof rp.jealousy === "number") next.relationship.tension.jealousy = clamp(rp.jealousy, 0, 100);
          if (typeof rp.recentAfterglow === "string") next.relationship.tension.recentAfterglow = rp.recentAfterglow.trim();
        }

        if (isRecord(payload.upsertPromise) && typeof payload.upsertPromise.content === "string" && payload.upsertPromise.content.trim()) {
          const up = payload.upsertPromise;
          const id = typeof up.id === "string" && up.id.trim() ? up.id.trim() : nanoid(6);
          const dueIso = typeof up.dueClock === "string" && up.dueClock.trim()
            ? (parseDisplayClockToIso(up.dueClock, next.clock.timezone) ?? undefined)
            : undefined;
          const entry = statefulRpPromiseSchema.parse({
            id,
            content: String(up.content).trim(),
            createdAtIso: next.clock.currentIso,
            dueIso,
            status: typeof up.status === "string" && ["pending", "fulfilled", "broken", "overdue"].includes(up.status)
              ? up.status
              : "pending"
          });
          const idx = next.relationship.promises.findIndex((item) => item.id === id || item.content === entry.content);
          if (idx >= 0) {
            next.relationship.promises[idx] = entry;
          } else {
            next.relationship.promises.push(entry);
          }
        }

        if (typeof payload.reason === "string" && payload.reason.trim()) {
          next.journal.push(statefulRpJournalEntrySchema.parse({
            id: nanoid(8),
            clockIso: next.clock.currentIso,
            category: isRecord(payload.relationshipPatch) || isRecord(payload.upsertPromise) ? "relationship" : "mind",
            summary: payload.reason.trim()
          }));
        }

        return next;
      }
    );
    context.persistSession?.(context.lastMessage.sessionId, "stateful_rp_mind_relation_updated");
    return JSON.stringify({ ok: true, state });
  },

  async stateful_rp_update_scene(_toolCall, args, context) {
    const denied = ensureStatefulRpMode(context);
    if (denied) {
      return denied;
    }
    const payload = isRecord(args) ? args : {};
    const state = await context.statefulRpStateStore!.update(
      context.lastMessage.sessionId,
      (current) => {
        let next: StatefulRpSessionState = structuredClone(current);
        next.initialized = true;

        const activityKind: StatefulRpActivityKind =
          typeof payload.activityKind === "string" && (statefulRpActivityKinds as readonly string[]).includes(payload.activityKind)
            ? (payload.activityKind as StatefulRpActivityKind)
            : next.clock.lastActivityKind;

        let elapsedMinutes = 0;
        if (typeof payload.advanceMinutes === "number" && Number.isFinite(payload.advanceMinutes) && payload.advanceMinutes > 0) {
          elapsedMinutes = Math.round(payload.advanceMinutes);
        } else if (typeof payload.setClock === "string" && payload.setClock.trim()) {
          const targetIso = parseDisplayClockToIso(payload.setClock, next.clock.timezone);
          if (targetIso) {
            const diffMs = Date.parse(targetIso) - Date.parse(next.clock.currentIso);
            if (diffMs > 0) {
              elapsedMinutes = Math.round(diffMs / 60_000);
            } else {
              const derived = deriveClockFields(targetIso);
              next.clock.currentIso = derived.currentIso;
              next.clock.dayOfWeek = derived.dayOfWeek;
              next.clock.timeOfDay = derived.timeOfDay;
            }
          }
        }

        if (elapsedMinutes > 0) {
          const ticked = applyDeterministicTimeTick(next, {
            elapsedMinutes,
            activityKind,
            isSeparated: typeof payload.isSeparated === "boolean" ? payload.isSeparated : next.world.isSeparated
          });
          next = ticked.nextState;
        }

        if (typeof payload.currentLocation === "string" && payload.currentLocation.trim()) {
          next.world.currentLocation = payload.currentLocation.trim();
        }
        if (Array.isArray(payload.locationTags)) {
          next.world.locationTags = payload.locationTags.map((item) => String(item ?? "").trim()).filter(Boolean);
        }
        if (typeof payload.weather === "string" && payload.weather.trim()) {
          next.world.weather = payload.weather.trim();
        }
        if (typeof payload.isSeparated === "boolean") {
          next.world.isSeparated = payload.isSeparated;
        }
        if (Array.isArray(payload.presentNpcs)) {
          next.world.presentNpcs = payload.presentNpcs.map((item) => String(item ?? "").trim()).filter(Boolean);
        }
        if (typeof payload.ambientPressure === "string") {
          next.world.ambientPressure = payload.ambientPressure.trim();
        }

        if (isRecord(payload.upsertSchedule) && typeof payload.upsertSchedule.title === "string") {
          const us = payload.upsertSchedule;
          const startIso = parseDisplayClockToIso(String(us.startClock ?? ""), next.clock.timezone) ?? next.clock.currentIso;
          const endIso = parseDisplayClockToIso(String(us.endClock ?? ""), next.clock.timezone) ?? startIso;
          const id = typeof us.id === "string" && us.id.trim() ? us.id.trim() : nanoid(6);
          const entry = statefulRpScheduleEntrySchema.parse({
            id,
            title: String(us.title).trim(),
            startIso,
            endIso,
            location: String(us.location ?? next.world.currentLocation).trim(),
            status: typeof us.status === "string" && ["pending", "completed", "missed", "cancelled"].includes(us.status)
              ? us.status
              : "pending"
          });
          const idx = next.world.schedule.findIndex((item) => item.id === id);
          if (idx >= 0) {
            next.world.schedule[idx] = entry;
          } else {
            next.world.schedule.push(entry);
          }
        }

        if (typeof payload.reason === "string" && payload.reason.trim()) {
          next.journal.push(statefulRpJournalEntrySchema.parse({
            id: nanoid(8),
            clockIso: next.clock.currentIso,
            category: "world",
            summary: payload.reason.trim()
          }));
        }

        return next;
      }
    );
    context.persistSession?.(context.lastMessage.sessionId, "stateful_rp_scene_updated");
    return JSON.stringify({ ok: true, state });
  },

  async stateful_rp_inspect(_toolCall, args, context) {
    const denied = ensureStatefulRpMode(context);
    if (denied) {
      return denied;
    }
    const payload = isRecord(args) ? args : {};
    const section = typeof payload.section === "string" ? payload.section.trim() : "all";
    const state = await context.statefulRpStateStore!.ensure(context.lastMessage.sessionId);
    if (section === "embodiment") return JSON.stringify(state.embodiment);
    if (section === "mind") return JSON.stringify(state.mind);
    if (section === "relationship") return JSON.stringify(state.relationship);
    if (section === "world") return JSON.stringify({ clock: state.clock, world: state.world });
    if (section === "journal") return JSON.stringify(state.journal);
    if (section === "maintenanceLog") return JSON.stringify(state.maintenanceLog);
    return JSON.stringify(state);
  }
};

function inferLayerFromSlot(slot: StatefulRpClothingItem["slot"]): StatefulRpClothingItem["layer"] {
  if (slot === "bra" || slot === "underwear") return "intimate";
  if (slot === "hosiery") return "base";
  if (slot === "footwear") return "footwear";
  if (slot === "outerwear") return "outer";
  if (slot === "accessory") return "accessory";
  return "mid";
}

function normalizeClothingItems(items: unknown[]): StatefulRpClothingItem[] {
  const result: StatefulRpClothingItem[] = [];
  for (const raw of items) {
    if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name.trim()) {
      continue;
    }
    const slot = typeof raw.slot === "string" && ["bra", "underwear", "hosiery", "top", "bottom", "dress", "outerwear", "footwear", "accessory"].includes(raw.slot)
      ? (raw.slot as StatefulRpClothingItem["slot"])
      : "top";
    const layer = typeof raw.layer === "string" && ["intimate", "base", "mid", "outer", "footwear", "accessory"].includes(raw.layer)
      ? (raw.layer as StatefulRpClothingItem["layer"])
      : inferLayerFromSlot(slot);
    const parsed = statefulRpClothingItemSchema.parse({
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `${slot}-${nanoid(4)}`,
      slot,
      layer,
      name: raw.name.trim(),
      material: typeof raw.material === "string" ? raw.material.trim() : "",
      fit: typeof raw.fit === "string" && ["tight", "fitted", "loose", "sheer", "binding"].includes(raw.fit)
        ? raw.fit
        : "fitted",
      breathability: typeof raw.breathability === "number" ? clamp(raw.breathability, 0, 100) : (slot === "hosiery" ? 45 : 70),
      displacement: typeof raw.displacement === "string" && ["normal", "shifted", "unfastened", "pulled_aside", "rolled_up", "half_off"].includes(raw.displacement)
        ? raw.displacement
        : "normal",
      wornMinutes: typeof raw.wornMinutes === "number" ? Math.max(0, Math.round(raw.wornMinutes)) : 0,
      wetness: typeof raw.wetness === "number" ? clamp(raw.wetness, 0, 100) : 0,
      secretionStain: typeof raw.secretionStain === "number" ? clamp(raw.secretionStain, 0, 100) : 0,
      odorIntensity: typeof raw.odorIntensity === "number" ? clamp(raw.odorIntensity, 0, 100) : 0,
      odorNote: typeof raw.odorNote === "string" ? raw.odorNote.trim() : "",
      wrinkles: typeof raw.wrinkles === "number" ? clamp(raw.wrinkles, 0, 100) : 0,
      comfort: typeof raw.comfort === "number" ? clamp(raw.comfort, 0, 100) : 85,
      conditionNote: typeof raw.conditionNote === "string" ? raw.conditionNote.trim() : ""
    });
    result.push(parsed);
  }
  return result;
}

function mergeClothingItem(existing: StatefulRpClothingItem, patch: Record<string, unknown>): StatefulRpClothingItem {
  return statefulRpClothingItemSchema.parse({
    ...existing,
    ...(typeof patch.slot === "string" && ["bra", "underwear", "hosiery", "top", "bottom", "dress", "outerwear", "footwear", "accessory"].includes(patch.slot) ? { slot: patch.slot } : {}),
    ...(typeof patch.layer === "string" && ["intimate", "base", "mid", "outer", "footwear", "accessory"].includes(patch.layer) ? { layer: patch.layer } : {}),
    ...(typeof patch.name === "string" && patch.name.trim() ? { name: patch.name.trim() } : {}),
    ...(typeof patch.material === "string" ? { material: patch.material.trim() } : {}),
    ...(typeof patch.fit === "string" && ["tight", "fitted", "loose", "sheer", "binding"].includes(patch.fit) ? { fit: patch.fit } : {}),
    ...(typeof patch.breathability === "number" ? { breathability: clamp(patch.breathability, 0, 100) } : {}),
    ...(typeof patch.displacement === "string" && ["normal", "shifted", "unfastened", "pulled_aside", "rolled_up", "half_off"].includes(patch.displacement) ? { displacement: patch.displacement } : {}),
    ...(typeof patch.wornMinutes === "number" ? { wornMinutes: Math.max(0, Math.round(patch.wornMinutes)) } : {}),
    ...(typeof patch.wetness === "number" ? { wetness: clamp(patch.wetness, 0, 100) } : {}),
    ...(typeof patch.secretionStain === "number" ? { secretionStain: clamp(patch.secretionStain, 0, 100) } : {}),
    ...(typeof patch.odorIntensity === "number" ? { odorIntensity: clamp(patch.odorIntensity, 0, 100) } : {}),
    ...(typeof patch.odorNote === "string" ? { odorNote: patch.odorNote.trim() } : {}),
    ...(typeof patch.wrinkles === "number" ? { wrinkles: clamp(patch.wrinkles, 0, 100) } : {}),
    ...(typeof patch.comfort === "number" ? { comfort: clamp(patch.comfort, 0, 100) } : {}),
    ...(typeof patch.conditionNote === "string" ? { conditionNote: patch.conditionNote.trim() } : {})
  });
}

function normalizeIntimateGear(items: unknown[]): StatefulRpIntimateGear[] {
  const result: StatefulRpIntimateGear[] = [];
  for (const raw of items) {
    if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name.trim()) {
      continue;
    }
    result.push(statefulRpIntimateGearSchema.parse({
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `gear-${nanoid(4)}`,
      name: raw.name.trim(),
      position: typeof raw.position === "string" && raw.position.trim() ? raw.position.trim() : "私密部位",
      intensity: typeof raw.intensity === "number" ? clamp(raw.intensity, 0, 100) : 30,
      concealed: typeof raw.concealed === "boolean" ? raw.concealed : true,
      wornMinutes: typeof raw.wornMinutes === "number" ? Math.max(0, Math.round(raw.wornMinutes)) : 0,
      effectNote: typeof raw.effectNote === "string" ? raw.effectNote.trim() : ""
    }));
  }
  return result;
}
