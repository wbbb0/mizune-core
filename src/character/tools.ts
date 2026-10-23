import { selectedSetupSection, selectSetupSection, setupEditDefinition, mergeSetupValue } from "./setupEditing.ts";
import { normalizeSetupContainers, setupInputErrors, setupInputFailure } from "../llm/tools/setup/inputValidation.ts";
import { emptyValue, type JsonObject } from "./schemaCatalog.ts";
import type { ToolDescriptor, ToolHandler } from "#llm/tools/core/shared.ts";
import { characterRepository } from "./repository.ts";

export const characterToolNames = ["list_character_sections", "read_character_section", "edit_character_section"];
export const characterToolDescriptors: ToolDescriptor[] = [
  { definition: { type: "function", function: { name: characterToolNames[0]!, description: "列出当前角色配置阶段或动态状态的分块目录与填写进度，不返回整份档案。先调用此工具，再按自然路径读取单块。", parameters: { type: "object", properties: {}, additionalProperties: false } } } },
  { definition: { type: "function", function: { name: characterToolNames[1]!, description: "读取指定分块的字段说明、格式与当前值。例如 persona.name、social.identity、embodiment.physiology.menstrualCycle。", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } } } },
  { definition: { type: "function", function: { name: characterToolNames[2]!, description: "只填写当前一个分块；集合按单条 ID 增改或删除。配置只写草稿，由用户 .confirm 发布。用户明确不填可 skip。普通游玩只能写动态状态。周期发生日期由代码控制。", parameters: { type: "object", properties: { id: { type: "string" }, action: { type: "string", enum: ["set", "upsert", "remove", "skip"] }, value: { description: "严格按 read_character_section 返回的 schema 提供一个分块或条目" }, itemId: { type: "string" }, draftId: { type: "string", description: "配置时传目录返回的草稿 ID；普通动态更新省略" } }, required: ["id", "action"], additionalProperties: false } } } }
];
export const characterToolHandlers: Record<string, ToolHandler> = {
  async list_character_sections(_call, _args, ctx) {
    const store = characterRepository(ctx.config.dataDir); const id = ctx.lastMessage.sessionId;
    const session = ctx.sessionManager.getSession(id); const draft = store.draft(id);
    if (draft && ctx.relationship !== "owner") return JSON.stringify({ error: "角色配置仅 owner 可访问" });
    return JSON.stringify({ stage: draft?.stage ?? "playing", draftId: draft?.id, sections: store.sections(id, session.modeId).map(section => ({ id: section.id, description: section.description, collectionKey: section.collectionKey, valueType: section.schema.type, writable: !!draft || section.scope === "session", nextStep: "调用 read_character_section 读取字段与对应编辑格式", touched: draft?.touched.includes(section.id) ?? false })) });
  },
  async read_character_section(_call, rawArgs, ctx) {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const store = characterRepository(ctx.config.dataDir); const id = ctx.lastMessage.sessionId;
    if (store.draft(id) && ctx.relationship !== "owner") return JSON.stringify({ error: "角色配置仅 owner 可访问" });
    try {
      const section = store.section(id, ctx.sessionManager.getSession(id).modeId, String(args.id));
      const draft = store.draft(id);
      if (draft) {
        selectSetupSection(ctx.config.dataDir, id, draft.id, section.id);
        const editTool = setupEditDefinition(section, draft.id);
        return JSON.stringify({ id: section.id, description: section.description, value: section.value, touched: section.touched, collectionKey: section.collectionKey, draftId: draft.id, editTool: editTool.function,
          nextStep: "下一次请求的 edit_character_section 已切换为本块格式。只传修改字段；省略 action 即保存，skip 保留已有值。", boundArguments: { id: section.id, draftId: draft.id } });
      }
      return JSON.stringify(section);
    }
    catch (error) { return JSON.stringify({ error: String(error) }); }
  },
  async edit_character_section(_call, rawArgs, ctx) {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const store = characterRepository(ctx.config.dataDir); const id = ctx.lastMessage.sessionId;
    if (store.draft(id) && ctx.relationship !== "owner") return JSON.stringify({ error: "角色配置仅 owner 可修改" });
    const draft = store.draft(id);
    if (draft) return editSetupSection(store, id, ctx.sessionManager.getSession(id).modeId, ctx.config.dataDir, args);
    if (!["set", "upsert", "remove", "skip"].includes(String(args.action))) return JSON.stringify({ error: "未知编辑动作" });
    try {
      store.edit(id, ctx.sessionManager.getSession(id).modeId, String(args.id), args.action as "set" | "upsert" | "remove" | "skip", args.value, typeof args.itemId === "string" ? args.itemId : undefined, typeof args.draftId === "string" ? args.draftId : undefined);
      return JSON.stringify({ saved: true, scope: store.draft(id) ? "draft" : "session", id: args.id });
    } catch (error) { return JSON.stringify({ error: String(error) }); }
  }
};

function editSetupSection(store: ReturnType<typeof characterRepository>, sessionId: string, mode: string, dataDir: string, args: Record<string, unknown>): string {
  const draft = store.draft(sessionId)!;
  const selected = selectedSetupSection(dataDir, sessionId);
  if (args.draftId !== draft.id) return JSON.stringify({ error: "草稿已变化或未提供草稿 ID", code: "stale_draft", saved: false, nextStep: "重新调用 list_character_sections，再读取需要的分块；不要将旧调用直接转写到新草稿。" });
  if (!selected || args.id !== selected.sectionId) return JSON.stringify({ error: "尚未读取当前分块，或已切换到另一分块", code: "section_not_selected", saved: false, nextStep: "先调用 read_character_section，使用其返回的当前编辑格式。" });
  try {
    const section = store.section(sessionId, mode, selected.sectionId);
    const schema = setupEditDefinition(section, draft.id).function.parameters as JsonObject;
    const normalized = normalizeSetupContainers(args, schema) as JsonObject;
    const errors = setupInputErrors(schema, normalized);
    if (errors.length) return setupInputFailure(errors, schema);
    const action = normalized.action ?? "save";
    if (action === "skip") {
      if ("value" in normalized || normalized.itemId != null) throw new Error("skip 不接受 value 或 itemId；它只保留已有内容并标记跳过");
      store.skipDraftSection(sessionId, mode, section.id, draft.id);
    } else if (action === "remove") {
      if (!normalized.itemId) throw new Error("删除条目必须提供 itemId；可先重新读取分块查看已有 ID");
      if ("value" in normalized) throw new Error("删除条目只需 itemId，不接受 value");
      if (!(section.value as JsonObject[]).some(item => item[section.collectionKey!] === normalized.itemId)) throw new Error("itemId 不存在，请读取已有条目 ID 后重试");
      store.edit(sessionId, mode, section.id, "remove", undefined, normalized.itemId, draft.id);
    } else {
      if (!("value" in normalized)) throw new Error("保存必须提供 value；想暂不填写请使用 action=skip");
      let value: unknown;
      if (section.collectionKey) {
        const itemKey = section.collectionKey;
        const itemId = normalized.itemId ?? normalized.value?.[itemKey];
        if (normalized.itemId && normalized.value?.[itemKey] && normalized.itemId !== normalized.value[itemKey]) throw new Error("itemId 与条目中的 ID 不一致");
        const existing = (section.value as JsonObject[]).find(item => item[itemKey] === itemId);
        if (normalized.itemId && !existing) throw new Error("要修改的 itemId 不存在；新增条目请省略 itemId");
        value = mergeSetupValue(existing ?? emptyValue(section.schema.items), normalized.value, section.schema.items);
        if (value && typeof value === "object") {
          if (itemId) (value as JsonObject)[itemKey] = itemId;
          else delete (value as JsonObject)[itemKey];
        }
        store.edit(sessionId, mode, section.id, "upsert", value, undefined, draft.id);
      } else {
        value = mergeSetupValue(section.value, normalized.value, section.schema);
        store.edit(sessionId, mode, section.id, "set", value, undefined, draft.id);
      }
    }
    return JSON.stringify({ saved: true, scope: "draft", id: section.id, action, value: store.section(sessionId, mode, section.id).value, nextStep: "可继续修改本块，或读取下一分块。只有用户 .confirm 才发布。" });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error), code: "setup_edit_rejected", saved: false,
      nextStep: "按错误修正输入；不确定字段或条目 ID 时重新读取分块。不要原样重复失败调用。" });
  }
}
