import type { SkillWriteInput } from "../types/skills.ts";
import { TOOLSET_DEFINITIONS } from "../llm/tools/toolsetCatalog.ts";
import { parseSkillDocument, validateSkillResources } from "./skillDocument.ts";
import { SkillError } from "./skillError.ts";

/** 草稿与发布共用结构校验；不读取或修改正式库。 */
export function validateSkillWriteInput(input: SkillWriteInput): ReturnType<typeof parseSkillDocument> {
  try {
    return validateInput(input);
  } catch (error) {
    throw new SkillError(error instanceof Error ? error.message : String(error));
  }
}

function validateInput(input: SkillWriteInput): ReturnType<typeof parseSkillDocument> {
  if (!input || typeof input !== "object") throw new Error("技能内容必须为对象。");
  if (input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new Error("技能基准版本无效。");
  }
  if (typeof input.document !== "string") throw new Error("技能文档必须为字符串。");
  const parsed = parseSkillDocument(input.document);
  validateSkillResources(input.resources);
  if (typeof input.modelEditable !== "boolean" || typeof input.modelPaused !== "boolean" || !["auto", "disabled"].includes(input.userPolicy)) {
    throw new Error("技能策略无效。");
  }
  if (!Array.isArray(input.toolsetIds) || input.toolsetIds.some(id => !TOOLSET_DEFINITIONS.some(toolset => toolset.id === id))) {
    throw new Error("绑定了未知工具集。");
  }
  if (input.changeReason !== undefined && typeof input.changeReason !== "string") throw new Error("技能变更理由必须为字符串。");
  if (input.modelPauseReason != null && typeof input.modelPauseReason !== "string") throw new Error("技能暂停原因必须为字符串。");
  if (input.modelPaused && !input.modelPauseReason?.trim()) throw new Error("暂停技能时必须填写原因。");
  return parsed;
}
