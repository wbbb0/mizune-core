import { selectSetupSection, setupEditBindings } from "./setupEditing.ts";
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
    return JSON.stringify({ stage: draft?.stage ?? "playing", sections: store.sections(id, session.modeId).map(section => ({ id: section.id, description: section.description, collectionKey: section.collectionKey, valueType: section.schema.type, writable: !!draft || section.scope === "session", nextStep: "调用 read_character_section 读取字段与对应编辑格式", touched: draft?.touched.includes(section.id) ?? false })) });
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
        const editTools = setupEditBindings(section, draft.id).map(binding => binding.definition.function);
        return JSON.stringify({ id: section.id, description: section.description, value: section.value, touched: section.touched, collectionKey: section.collectionKey, editTools,
          nextStep: "使用本块对应的填写、新增、修改、删除或跳过工具，直接传业务字段，不需要 action、value、分块 ID 或草稿 ID。工具名由系统提供，不要自行拼接。" });
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
    if (draft) return JSON.stringify({ error: "配置阶段请使用当前分块的专用工具", code: "setup_requires_bound_tool", saved: false, nextStep: "调用 read_character_section 后，使用返回的专用填写工具，直接传业务字段。" });
    if (!["set", "upsert", "remove", "skip"].includes(String(args.action))) return JSON.stringify({ error: "未知编辑动作" });
    try {
      store.edit(id, ctx.sessionManager.getSession(id).modeId, String(args.id), args.action as "set" | "upsert" | "remove" | "skip", args.value, typeof args.itemId === "string" ? args.itemId : undefined, typeof args.draftId === "string" ? args.draftId : undefined);
      return JSON.stringify({ saved: true, scope: store.draft(id) ? "draft" : "session", id: args.id });
    } catch (error) { return JSON.stringify({ error: String(error) }); }
  }
};
