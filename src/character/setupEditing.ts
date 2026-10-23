import type { LlmToolDefinition } from "../llm/llmClient.ts";
import { characterRepository } from "./repository.ts";
import { emptyValue, type CharacterSection, type JsonObject } from "./schemaCatalog.ts";

// 仅保存读取位置，不保存角色内容。草稿 ID 隔离阶段；重启后重新读取即可。
const selections = new Map<string, { draftId: string; sectionId: string }>();
const key = (dataDir: string, sessionId: string) => JSON.stringify([dataDir, sessionId]);
export function selectSetupSection(dataDir: string, sessionId: string, draftId: string, sectionId: string): void {
  if (selections.size >= 1000) selections.delete(selections.keys().next().value!);
  selections.set(key(dataDir, sessionId), { draftId, sectionId });
}
export function selectedSetupSection(dataDir: string, sessionId: string) {
  const selected = selections.get(key(dataDir, sessionId));
  if (selected?.draftId !== characterRepository(dataDir).draft(sessionId)?.id) return null;
  return selected ?? null;
}
export function partialObjectSchema(schema: JsonObject): JsonObject {
  if (!schema.properties) return structuredClone(schema);
  const result = structuredClone(schema);
  delete result.required;
  result.properties = Object.fromEntries(Object.entries(result.properties).map(([name, child]) => [name, partialObjectSchema(child as JsonObject)]));
  return result;
}
export function mergeSetupValue(current: unknown, patch: unknown, schema: JsonObject): unknown {
  if (!schema.properties || !patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base = current && typeof current === "object" && !Array.isArray(current) ? structuredClone(current) as JsonObject : emptyValue({ ...schema, type: "object" });
  for (const [name, value] of Object.entries(patch)) {
    if (["__proto__", "constructor", "prototype"].includes(name)) throw new Error("无效字段名称");
    base[name] = schema.properties[name] ? mergeSetupValue(base[name], value, schema.properties[name]) : value;
  }
  return base;
}
export function setupEditDefinition(section: CharacterSection, draftId: string): LlmToolDefinition {
  const valueSchema = section.collectionKey ? partialObjectSchema(section.schema.items) : partialObjectSchema(section.schema);
  const codeFields = section.id === "session.simulation.clock"
    ? ["dayOfWeek", "timeOfDay", "minutesSinceLastSensoryTick", "minutesSinceLastMindTick", "separatedMinutesAccumulated"]
    : section.id === "session.simulation.body.activePhysiology.menstrualCycle" ? ["nextStartDate", "currentEndDate", "active"] : [];
  for (const field of codeFields) delete valueSchema.properties?.[field];
  return { type: "function", function: {
    name: "edit_character_section",
    description: `修改当前配置分块 ${section.id}：${section.description}。省略 action 即保存；对象只传要修改的字段，未提供的字段保持原值，null 明确清空。${section.collectionKey ? "集合每次一条；修改或删除传 itemId，新增省略 itemId。" : "普通数组整体替换。"} skip 仅标记本块暂不填写，不清空已有内容。需要换块先调用 read_character_section。draftId 和 id 使用下面规定的固定值，不能替玩家确认。`,
    parameters: { type: "object", properties: {
      id: { type: "string", enum: [section.id] }, draftId: { type: "string", enum: [draftId] },
      action: { type: "string", enum: section.collectionKey ? ["save", "remove", "skip"] : ["save", "skip"], description: "省略时保存；remove 删除一条集合记录；skip 保留当前值并跳过" },
      value: { ...valueSchema, description: `${valueSchema.description ?? ""} 直接传符合类型的值，不要将对象或数组序列化成字符串。` },
      ...(section.collectionKey ? { itemId: { type: "string", description: "现有条目的 ID。新增时省略，由系统生成；删除时必填。" } } : {})
    }, required: ["id", "draftId"], additionalProperties: false }
  } };
}
