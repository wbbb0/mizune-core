import { skillObservation } from "../../../skills/skillObservation.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import type { SkillWriteInput } from "../../../types/skills.ts";
import { getSkillStore } from "../../../skills/skillStore.ts";
import { requireActiveSkillDraft, writeSkillDraft } from "../../../skills/skillDrafts.ts";
import { keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDescriptor => ({
  definition: { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } },
  isEnabled: config => config.skills.enabled,
  resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 3 })
});
export const SKILL_TOOL_NAMES = ["list_skills", "load_skill", "read_skill_resource", "get_skill", "save_skill", "set_skill_paused"];
export const skillToolDescriptors: ToolDescriptor[] = [
  definition("list_skills", "查看当前任务可用技能短目录。技能只提供方法，不授予工具权限。", {}),
  definition("load_skill", "按需加载技能的固定任务版本。先阅读正文，再重新计划相关动作。新建与改版下个任务生效。", { id: { type: "string" }, reason: { type: "string" } }, ["id", "reason"]),
  definition("read_skill_resource", "读取已加载技能的 references 引用文档，路径使用短目录返回的相对路径。", { id: { type: "string" }, path: { type: "string" } }, ["id", "path"]),
  { ...definition("get_skill", "查看技能全文和revision用于维护；配置流程中返回临时草稿。", { id: { type: "string" } }, ["id"]), accessLevel: "owner" },
  { ...definition("save_skill", "新增或编辑技能，提交完整标准SKILL.md、引用和工具集绑定。自主维护必须填写具体依据changeReason；不能解除用户禁用或锁定。配置草稿阶段仅暂存，等待用户.confirm。", {
      id: { type: "string" }, expectedRevision: { type: ["integer", "null"] }, document: { type: "string" }, resources: { type: "object", additionalProperties: { type: "string" } }, toolsetIds: { type: "array", items: { type: "string" } },
      userPolicy: { type: "string", enum: ["auto", "disabled"] }, modelEditable: { type: "boolean" }, modelPaused: { type: "boolean" }, modelPauseReason: { type: ["string", "null"] }, changeReason: { type: "string" }
    }, ["id", "expectedRevision", "document", "resources", "toolsetIds", "userPolicy", "modelEditable", "modelPaused", "changeReason"]), accessLevel: "owner" },
  { ...definition("set_skill_paused", "自主暂停或恢复未锁定且未禁用的技能，必须说明依据。", { id: { type: "string" }, expectedRevision: { type: "integer" }, paused: { type: "boolean" }, reason: { type: "string" } }, ["id", "expectedRevision", "paused", "reason"]), accessLevel: "owner" }
];
function objectArgs(args: unknown): Record<string, unknown> { return args && typeof args === "object" ? args as Record<string, unknown> : {}; }
export const skillToolHandlers: Record<string, ToolHandler> = {
  async list_skills(_call, _args, context) { return JSON.stringify({ catalog: context.skillAccess?.catalog() ?? "", ...(context.relationship === "owner" && context.config.skills.modelMaintenanceEnabled ? { maintenance_skills: getSkillStore(context.config).list().filter(skill => skill.userPolicy !== "disabled") } : {}) }); },
  async load_skill(_call, args, context) {
    const values = objectArgs(args);
    const result = context.skillAccess?.load(String(values.id ?? ""), String(values.reason ?? "模型按需加载"));
    return result?.skill ? skillObservation("load", [result.skill], { ok: true, loaded: true, skill: projectSkillForModel(result.skill) }) : JSON.stringify(result ?? { error: "当前任务不能加载技能。" });
  },
  async read_skill_resource(_call, args, context) {
    const values = objectArgs(args);
    const id = String(values.id ?? "");
    const result = context.skillAccess?.readResource(id, String(values.path ?? ""));
    return result?.revision != null ? skillObservation("resource", [{ id, revision: result.revision }], { ...result, id, path: values.path }) : JSON.stringify(result ?? { error: "当前任务不能读取技能。" });
  },
  async get_skill(_call, args, context) {
    if (context.relationship !== "owner")
      throw new Error("只有 owner 可管理实例技能。");
    const id = String(objectArgs(args).id ?? "");
    const draft = requireActiveSkillDraft(context.config, context.lastMessage.sessionId, context.sessionManager.getOperationMode(context.lastMessage.sessionId));
    if (draft?.id === id)
      return JSON.stringify({ draft });
    if (!context.config.skills.modelMaintenanceEnabled)
      throw new Error("模型自主维护未启用。");
    const store = getSkillStore(context.config);
    const skill = store.get(id);
    if (!skill || skill.userPolicy === "disabled")
      throw new Error("技能不存在或已禁用。");
    return skillObservation("maintenance", [skill], { skill: projectSkillForModel(skill) });
  },
  async save_skill(_call, args, context) {
    if (context.relationship !== "owner")
      throw new Error("只有 owner 可管理实例技能。");
    const values = objectArgs(args);
    const id = String(values.id ?? "");
    const input = values as unknown as SkillWriteInput;
    const draft = requireActiveSkillDraft(context.config, context.lastMessage.sessionId, context.sessionManager.getOperationMode(context.lastMessage.sessionId));
    if (draft) {
      if (draft.id !== id || draft.input.expectedRevision !== input.expectedRevision)
        throw new Error("草稿ID或版本不匹配。");
      writeSkillDraft(context.config, context.lastMessage.sessionId, { id, input });
      return JSON.stringify({ ok: true, draft: true, message: "草稿已更新，等待用户.confirm发布。", content: input });
    }
    const skill = getSkillStore(context.config).write(id, input, "model");
    return skillObservation("maintenance", [skill], { skill: projectSkillForModel(skill), effective: "下个任务" });
  },
  async set_skill_paused(_call, args, context) {
    if (context.relationship !== "owner")
      throw new Error("只有 owner 可管理实例技能。");
    const values = objectArgs(args);
    const draft = requireActiveSkillDraft(context.config, context.lastMessage.sessionId, context.sessionManager.getOperationMode(context.lastMessage.sessionId));
    if (draft) {
      if (draft.id !== values.id || draft.input.expectedRevision !== values.expectedRevision)
        throw new Error("草稿ID或版本不匹配。");
      draft.input.modelPaused = values.paused as boolean;
      draft.input.modelPauseReason = String(values.reason ?? "");
      draft.input.changeReason = String(values.reason ?? "");
      writeSkillDraft(context.config, context.lastMessage.sessionId, draft);
      return JSON.stringify({ ok: true, draft: true, content: draft });
    }
    const store = getSkillStore(context.config);
    const current = store.get(String(values.id ?? ""));
    if (!current)
      throw new Error("技能不存在。");
    const skill = store.write(current.id, { ...current, expectedRevision: values.expectedRevision as number, modelPaused: values.paused as boolean, modelPauseReason: String(values.reason ?? ""), changeReason: String(values.reason ?? "") }, "model");
    return skillObservation("maintenance", [skill], { skill: projectSkillForModel(skill) });
  }
};
export function projectSkillForModel(skill: import("../../../types/skills.ts").SkillRecord) {
  const { resources, ...record } = skill;
  return { ...record, resourcePaths: Object.keys(resources).sort() };
}
