import type { SessionOperationMode } from "#conversation/session/sessionOperationMode.ts";

export const SKILL_TOOL_NAMES = ["list_skills", "load_skill", "read_skill_resource", "get_skill", "save_skill", "set_skill_paused"];
export const SKILL_MAINTENANCE_TOOL_NAMES = ["get_skill", "save_skill", "set_skill_paused"];

export interface SkillSessionContext {
  modeId?: string | null | undefined;
  operationMode?: SessionOperationMode | undefined;
  setupMode?: boolean | undefined;
}

/** 技能配置是独立流程；其他配置/初始化轮次不加载技能，也不开放技能工具。 */
export function isSkillRuntimeAllowedForSession(
  modeId?: string | null,
  operationMode?: SessionOperationMode,
  options?: { setupMode?: boolean | undefined }
): boolean {
  if (options?.setupMode) return false;
  if (operationMode?.kind === "skill_config") return true;
  if (operationMode && operationMode.kind !== "normal") return false;
  return modeId !== "stateful_rp";
}
