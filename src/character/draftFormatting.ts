import type { CharacterDraft } from "./model.ts";
import { characterSections, readSectionValue, type JsonObject } from "./schemaCatalog.ts";

const stageLabels = { persona: "基础人格", social: "社交设定", embodiment: "具身设定与初始衣柜", state: "会话初始状态" };

/** 只格式化当前阶段的持久化草稿快照，不读取已确认档案或修改任何状态。 */
export function formatCharacterDraft(draft: CharacterDraft): string {
  const sections = characterSections.filter(section => draft.stage === "state"
    ? section.scope === "session"
    : section.scope === "character" && section.path[0] === draft.stage);
  return [
    `${stageLabels[draft.stage]}${draft.phase === "setup" ? "初始化" : "配置"}草稿`,
    ...sections.flatMap(section => ["", ...formatValue(readSectionValue(draft.value, section), section.schema, section.description)]),
    "",
    "以上为当前阶段的完整草稿，尚未发布。确认无误后输入 .confirm 保存；需要调整请继续说明，.cancel 放弃当前草稿。"
  ].join("\n");
}

function fieldLabel(schema: JsonObject, fallback: string): string {
  return schema.title || schema.description?.split(/[。；\n]/, 1)[0] || fallback;
}

function formatValue(value: unknown, schema: JsonObject, label: string, indent = ""): string[] {
  const prefix = `${indent}${label}：`;
  if (value == null || typeof value === "string" && !value.trim()) return [`${prefix}（未填写）`];
  if (Array.isArray(value)) {
    if (!value.length) return [`${prefix}（空）`];
    return [prefix, ...value.flatMap((item, index) => formatValue(item, schema.items ?? {}, `第 ${index + 1} 项`, `${indent}  `))];
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(schema.properties ?? {}), ...Object.keys(object)])];
    if (!keys.length) return [`${prefix}（空）`];
    return [prefix, ...keys.flatMap(key => {
      const child = schema.properties?.[key] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : {});
      return formatValue(object[key], child, fieldLabel(child, key), `${indent}  `);
    })];
  }
  const text = typeof value === "boolean" ? value ? "是" : "否" : String(value);
  return text.split("\n").map((line, index) => index === 0 ? `${prefix}${line}` : `${indent}  ${line}`);
}
