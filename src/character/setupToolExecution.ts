import type { BuiltinToolContext } from "../llm/tools/core/shared.ts";
import { setupInputErrors, setupInputFailure } from "../llm/tools/setup/inputValidation.ts";
import { characterRepository } from "./repository.ts";
import { emptyValue, type JsonObject } from "./schemaCatalog.ts";
import { stageSetupBindings, mergeSetupValue, hasGeneratedCollectionKey } from "./setupEditing.ts";

/** 稳定工具对应固定分块；生成轮次绑定草稿，旧调用不能转写新草稿。 */
export function executeCharacterSetupTool(name: string, args: unknown, context: BuiltinToolContext, expectedDraftId: string | null): string {
  if (context.relationship !== "owner") return JSON.stringify({ error: "角色配置仅 owner 可修改", saved: false });
  const sessionId = context.lastMessage.sessionId;
  const store = characterRepository(context.config.dataDir);
  const draft = store.draft(sessionId);
  const stale = () => JSON.stringify({ error: "当前配置草稿已变化，本轮工具调用已失效", code: "stale_setup_tool", saved: false,
    nextStep: "请在新的配置轮次中继续操作。" });
  if (!draft || draft.id !== expectedDraftId) return stale();
  try {
    const mode = context.sessionManager.getSession(sessionId).modeId;
    const binding = stageSetupBindings(draft.stage, draft.id).find(item => item.definition.function.name === name);
    if (!binding) return stale();
    const section = store.section(sessionId, mode, binding.sectionId);
    const schema = binding.definition.function.parameters;
    const errors = setupInputErrors(schema, args);
    if (errors.length) return setupInputFailure(errors, schema);
    const input = args as JsonObject;
    const action = binding.action;
    let itemId: string | undefined;
    if (action === "skip") store.skipDraftSection(sessionId, mode, section.id, binding.draftId);
    else if (action === "clear") store.edit(sessionId, mode, section.id, "set", null, undefined, binding.draftId);
    else if (section.collectionKey) {
      const itemKey = section.collectionKey;
      const items = section.value as JsonObject[];
      const existing = items.find(item => item[itemKey] === input.itemId);
      if (action !== "add" && !existing) throw new Error("itemId 不存在，请先读取已有条目 ID");
      if (action === "remove") {
        itemId = input.itemId;
        store.edit(sessionId, mode, section.id, "remove", undefined, itemId, binding.draftId);
      } else {
        const { itemId: _itemId, ...patch } = input;
        if (!Object.keys(patch).length) throw new Error("请至少填写一个要新增或修改的业务字段；暂不填写可使用跳过工具");
        const value = mergeSetupValue(existing ?? emptyValue(section.schema.items), patch, section.schema.items) as JsonObject;
        if (action === "add") {
          if (hasGeneratedCollectionKey(section)) delete value[itemKey];
          else if (items.some(item => item[itemKey] === value[itemKey])) throw new Error("此引用已有记录，请使用修改工具，避免覆盖已有内容");
        }
        store.edit(sessionId, mode, section.id, "upsert", value, undefined, binding.draftId);
        const saved = store.section(sessionId, mode, section.id).value as JsonObject[];
        itemId = action === "add" ? saved.at(-1)![itemKey] : input.itemId;
      }
    } else {
      if (!Object.keys(input).length) throw new Error("请至少填写一个业务字段；暂不填写可使用跳过工具");
      const patch = section.schema.properties ? input : input[binding.fieldName];
      const value = mergeSetupValue(section.value, patch, section.schema);
      store.edit(sessionId, mode, section.id, "set", value, undefined, binding.draftId);
    }
    const changedFields = Object.keys(input).filter(field => field !== "itemId");
    return JSON.stringify({ saved: true, scope: "draft", section: section.id, ...(itemId ? { itemId } : {}), changedFields,
      message: action === "skip" ? "已跳过本块，已有内容保留。" : action === "remove" ? "已删除指定记录，尚未确认发布。" : action === "clear" ? "已清空本块，尚未确认发布。" : `已保存${changedFields.join("、")}，尚未确认发布。`,
      nextStep: "可继续编辑或读取下一分块；由用户 .confirm 发布。" });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error), code: "setup_edit_rejected", saved: false,
      nextStep: "按错误修正业务字段，不确定时重新读取分块；不要原样重复失败调用。" });
  }
}
