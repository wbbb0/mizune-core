export type MemoryCategory =
  | "persona"
  | "global_rules"
  | "toolset_rules"
  | "user_profile"
  | "user_memories";

export interface ScopeConflictWarning {
  code: "warning_scope_conflict";
  currentScope: MemoryCategory;
  suggestedScope: MemoryCategory;
  reason: string;
}

const PERSONA_PATTERNS = [
  /persona/u,
  /人设/u,
  /角色(设定|边界|身份|定位)/u,
  /口吻|语气|说话方式|说话风格/u
] as const;

const TOOLSET_LOCAL_PATTERNS = [
  /网页|浏览器|web|search/u,
  /shell|终端|命令行/u,
  /文件|workspace|工作区/u,
  /comfy|出图|生成图片/u,
  /定时|计划任务|scheduler/u
] as const;

const GLOBAL_WORKFLOW_PATTERNS = [
  /默认/u,
  /所有任务/u,
  /平时/u,
  /一般情况下/u,
  /回复时/u,
  /输出/u,
  /先给结论/u
] as const;

const USER_PROFILE_PATTERNS = [
  /称呼|怎么叫|叫我/u,
  /性别/u,
  /住在|居住|住地|城市|所在地/u,
  /时区/u,
  /职业|工作/u
] as const;

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function detectScopeConflict(input: {
  currentScope: MemoryCategory;
  title: string;
  content: string;
}): ScopeConflictWarning | null {
  const text = `${input.title}\n${input.content}`;
  if (input.currentScope === "global_rules" && matchesAny(text, PERSONA_PATTERNS)) {
    return {
      code: "warning_scope_conflict",
      currentScope: input.currentScope,
      suggestedScope: "persona",
      reason: "内容更像 bot 身份、人设、口吻或角色边界，而不是 owner 级通用工作流规则。"
    };
  }
  if (input.currentScope === "toolset_rules" && matchesAny(text, GLOBAL_WORKFLOW_PATTERNS) && !matchesAny(text, TOOLSET_LOCAL_PATTERNS)) {
    return {
      code: "warning_scope_conflict",
      currentScope: input.currentScope,
      suggestedScope: "global_rules",
      reason: "内容更像跨任务长期工作流规则，不像仅限某个工具集的局部操作规则。"
    };
  }
  if (input.currentScope === "user_memories" && matchesAny(text, USER_PROFILE_PATTERNS)) {
    return {
      code: "warning_scope_conflict",
      currentScope: input.currentScope,
      suggestedScope: "user_profile",
      reason: "内容更像结构化用户卡片字段，适合写入 user profile。"
    };
  }
  return null;
}
