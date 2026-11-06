import type { AppConfig } from "#config/config.ts";
import { getVisionInputModelRefsForRole } from "#llm/shared/visionModelRouting.ts";
import { setupEditBindings } from "./setupEditing.ts";
import type { ToolDescriptor, ToolHandler } from "#llm/tools/core/shared.ts";
import { importCharacterReference } from "./referenceImages.ts";
import { editCharacterSectionWithAssets } from "./writes.ts";
import { characterRepository } from "./repository.ts";

export const characterToolNames = [
  "list_character_sections",
  "read_character_section",
  "edit_character_section",
  "import_character_reference"
];
export function characterToolDescriptors(config?: AppConfig): ToolDescriptor[] {
  return [
    { modelPolicy: { kind: "observe" }, definition: { type: "function", function: { name: characterToolNames[0]!, description: "列出当前角色配置阶段或动态状态的分块目录与填写进度，不返回整份档案。按需查询，可直接使用对应编辑工具，无需先读取。", parameters: { type: "object", properties: {}, additionalProperties: false } } } },
    { modelPolicy: { kind: "observe" }, definition: { type: "function", function: { name: characterToolNames[1]!, description: "读取指定分块的字段说明、格式与当前值；集合分块可传 itemId 按单条读取。例如 persona.name、social.identity、social.referenceImages、embodiment.physiology.menstrualCycle。", parameters: { type: "object", properties: { id: { type: "string" }, itemId: { type: "string", description: "可选。读取集合分块中的单条记录 ID" } }, required: ["id"], additionalProperties: false } } } },
    { modelPolicy: { kind: "bounded_content" }, definition: { type: "function", function: { name: characterToolNames[2]!, description: "只填写当前一个分块；集合按单条 ID 增改或删除。配置只写草稿，由用户 .confirm 发布。用户明确不填可 skip。普通游玩只能写动态状态。周期发生日期由代码控制。", parameters: { type: "object", properties: { id: { type: "string" }, action: { type: "string", enum: ["set", "upsert", "remove", "skip"] }, value: { description: "严格按 read_character_section 返回的 schema 提供一个分块或条目" }, itemId: { type: "string" }, draftId: { type: "string", description: "配置时传目录返回的草稿 ID；普通动态更新省略" } }, required: ["id", "action"], additionalProperties: false } } } },
    {
      modelPolicy: { kind: "bounded_content" },
      definition: {
        type: "function",
        function: {
          name: characterToolNames[3]!,
          description: "在 social 角色配置阶段导入已登记的静态图片资产作为角色参考图（设定图/立绘），调用图片精读模型生成详细中文视觉描述并保存到当前会话 social 草稿（由用户 .confirm 发布）。仅在用户明确将该图片指定为角色设定图时调用。",
          parameters: {
            type: "object",
            properties: {
              asset_ref: {
                type: "string",
                description: "已登记的静态图片资产引用（asset_ref 或规范 file_id）。"
              },
              label: {
                type: "string",
                description: "可选。参考图简短标签，如“正面全身”“常服立绘”；传入时须为非空文本。"
              },
              subject: {
                type: "string",
                description: "可选。当图片包含多名角色或需指定目标主体时说明，如“左侧银发角色”。单人图省略。"
              },
              refresh: {
                type: "boolean",
                description: "可选。默认 false（同一图片与主体直接复用已有草稿记录）；设为 true 时重新调用精读模型覆盖描述。"
              }
            },
            required: ["asset_ref"],
            additionalProperties: false
          }
        }
      },
      accessLevel: "owner",
      isEnabled: (cfg) => cfg.chatFiles.enabled
        && cfg.llm.enabled
        && cfg.llm.imageInspector.enabled
        && getVisionInputModelRefsForRole(cfg, "image_inspector").modelRefs.length > 0,
      isVisible: (ctx) => Boolean(config?.dataDir && ctx.sessionId && characterRepository(config.dataDir).draft(ctx.sessionId)?.stage === "social")
    }
  ];
}
export const characterToolHandlers: Record<string, ToolHandler> = {
  async list_character_sections(_call, _args, ctx) {
    const store = characterRepository(ctx.config.dataDir); const id = ctx.lastMessage.sessionId;
    const session = ctx.sessionManager.getSession(id); const draft = store.draft(id);
    if (draft && ctx.relationship !== "owner") return JSON.stringify({ error: "角色配置仅 owner 可访问" });
    return JSON.stringify({
      stage: draft?.stage ?? "playing",
      sections: store.sections(id, session.modeId).map(section => ({
        id: section.id,
        description: section.description,
        collectionKey: section.collectionKey,
        valueType: section.schema.type,
        writable: section.writable,
        nextStep: section.writable
          ? "可直接使用对应编辑工具；按需读取当前值"
          : "已确认只读分块；可调用 read_character_section 读取当前值",
        touched: section.touched
      }))
    });
  },
  async read_character_section(_call, rawArgs, ctx) {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const store = characterRepository(ctx.config.dataDir); const id = ctx.lastMessage.sessionId;
    if (store.draft(id) && ctx.relationship !== "owner") return JSON.stringify({ error: "角色配置仅 owner 可访问" });
    try {
      const section = store.section(id, ctx.sessionManager.getSession(id).modeId, String(args.id), args.itemId);
      const draft = store.draft(id);
      if (draft) {
        if (!section.writable) {
          return JSON.stringify({
            id: section.id,
            description: section.description,
            value: section.value,
            ...(section.itemId !== undefined ? { itemId: section.itemId } : {}),
            writable: false,
            touched: false,
            collectionKey: section.collectionKey,
            nextStep: "此分块为已确认的前置设定（只读），仅供参考，不可在当前阶段直接修改。"
          });
        }
        const editTools = setupEditBindings(section, draft.id).map(binding => binding.definition.function);
        return JSON.stringify({
          id: section.id,
          description: section.description,
          value: section.value,
          ...(section.itemId !== undefined ? { itemId: section.itemId } : {}),
          writable: true,
          touched: section.touched,
          collectionKey: section.collectionKey,
          editTools,
          nextStep: "使用本块对应的填写、新增、修改、删除或跳过工具，直接传业务字段，不需要 action、value、分块 ID 或草稿 ID。工具名由系统提供，不要自行拼接。"
        });
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
    if (draft) return JSON.stringify({ error: "配置阶段请使用对应分块的专用工具", code: "setup_requires_bound_tool", saved: false, nextStep: "使用对应分块的专用填写工具，直接传业务字段，无需先读取。" });
    if (!["set", "upsert", "remove", "skip"].includes(String(args.action))) return JSON.stringify({ error: "未知编辑动作" });
    const modeId = ctx.sessionManager.getSession(id).modeId;
    try {
      await editCharacterSectionWithAssets({
        dataDir: ctx.config.dataDir,
        config: ctx.config,
        chatFileStore: ctx.chatFileStore,
        sessionId: id,
        modeId,
        abortSignal: ctx.abortSignal,
        assertCurrent: () => {
          if (ctx.sessionManager.getSession(id).modeId !== modeId || ctx.sessionManager.getOperationMode(id).kind !== "normal") {
            throw new Error("会话模式或配置阶段已变化，本轮写入失效");
          }
        },
        id: String(args.id),
        action: args.action as "set" | "upsert" | "remove" | "skip",
        value: args.value,
        ...(typeof args.itemId === "string" ? { itemId: args.itemId } : {}),
        ...(typeof args.draftId === "string" ? { draftId: args.draftId } : {})
      });
      return JSON.stringify({ saved: true, scope: store.draft(id) ? "draft" : "session", id: args.id });
    } catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : String(error) }); }
  },
  async import_character_reference(_call, rawArgs, ctx) {
    return await importCharacterReference(rawArgs, ctx, ctx.expectedCharacterDraftId);
  }
};
