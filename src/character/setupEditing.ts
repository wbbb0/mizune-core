import { createHash } from "node:crypto";
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
export type SetupEditAction = "fill" | "add" | "update" | "remove" | "skip" | "clear";
export interface SetupEditBinding {
  definition: LlmToolDefinition;
  sectionId: string;
  draftId: string;
  action: SetupEditAction;
  fieldName: string;
}
export const isCharacterSetupToolName = (name: string): boolean => /^setup_(fill|add|update|remove|skip|clear)_[a-zA-Z0-9_]+_[a-f0-9]{12}$/.test(name);

// participantId、穿戴记录的 instanceId 是业务引用，不能由系统随机生成。
export function hasGeneratedCollectionKey(section: CharacterSection): boolean {
  return section.collectionKey === "id" || section.id === "session.simulation.wardrobe.instances";
}

export function setupEditBindings(section: CharacterSection, draftId: string): SetupEditBinding[] {
  const valueSchema = section.collectionKey ? partialObjectSchema(section.schema.items) : partialObjectSchema(section.schema);
  const codeFields = section.id === "session.simulation.clock"
    ? ["dayOfWeek", "timeOfDay", "minutesSinceLastSensoryTick", "minutesSinceLastMindTick", "separatedMinutesAccumulated"]
    : section.id === "session.simulation.body.activePhysiology.menstrualCycle" ? ["nextStartDate", "currentEndDate", "active"] : [];
  for (const field of codeFields) delete valueSchema.properties?.[field];
  const fieldName = section.path.at(-1)!;
  const isObject = !!valueSchema.properties;
  const fields: JsonObject = isObject ? valueSchema.properties : { [fieldName]: valueSchema };
  const generatedKey = hasGeneratedCollectionKey(section);
  const actions: SetupEditAction[] = section.collectionKey ? ["add", "update", "remove", "skip"] : ["fill", "skip"];
  if (isObject && Array.isArray(section.schema.type) && section.schema.type.includes("null")) actions.push("clear");
  const token = createHash("sha256").update(JSON.stringify([draftId, section.id])).digest("hex").slice(0, 12);
  const label = section.path.join("_").replace(/[^a-zA-Z0-9_]/g, "_").slice(-36);
  const texts: Record<SetupEditAction, string> = {
    fill: "填写本块的业务字段。只传要修改的字段，未提供的字段保持原值，null 明确清空可空字段；普通数组整体替换。",
    add: generatedKey ? "新增一条记录，直接填写业务字段，系统生成 ID。不要传现有记录 ID。" : `新增一条关联记录，必须填写 ${section.collectionKey}，引用对应参与者或已有衣物实例；不要随机编造引用 ID。`,
    update: "修改一条已有记录。itemId 使用读取结果中的 ID；只传要修改的业务字段，其他字段保留。",
    remove: "删除一条已有记录。只传 itemId；删除前确认用户意图。",
    skip: "暂不填写本块，保留所有已有内容，不需要参数。",
    clear: "明确清空这个可空对象，设为 null。仅在用户明确要求清空时使用，不需要参数。"
  };
  return actions.map(action => {
    const properties: JsonObject = ["skip", "clear", "remove"].includes(action) ? {} : structuredClone(fields);
    const required: string[] = [];
    if (section.collectionKey) {
      if (action !== "add" || generatedKey) delete properties[section.collectionKey];
      else required.push(section.collectionKey);
    }
    if (action === "update" || action === "remove") {
      properties.itemId = { type: "string", minLength: 1, description: "读取结果中已有记录的 ID" };
      required.push("itemId");
    }
    if (action === "fill" && !isObject) required.push(fieldName);
    const parameters = { type: "object", properties, required, additionalProperties: false };
    return { sectionId: section.id, draftId, action, fieldName, definition: { type: "function", function: {
      name: `setup_${action}_${label}_${token}`,
      description: `${section.description}（${section.id}）。${texts[action]}文本字段直接填文本，如名称填小满；不要将 JSON 对象、数组或代码块填入字符串。本工具已绑定当前草稿和分块，无需传草稿 ID、分块 ID、action 或 value。用户 .confirm 前不会发布。`,
      parameters
    } } };
  });
}
