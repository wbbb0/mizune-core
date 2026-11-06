import type { SessionOperationMode } from "#conversation/session/sessionOperationMode.ts";
import type { ToolDescriptor } from "./shared.ts";

/** Declared next to the operation, independently of its name or containing toolset. */
export type ToolModelPolicy =
  | { kind: "observe" }
  | { kind: "bounded_content" }
  | { kind: "execution" }
  | { kind: "filesystem" }
  | { kind: "asset_or_filesystem"; pathParameter: string }
  | { kind: "browser_interaction" }
  | { kind: "persistent_policy" }
  | { kind: "external_effect" }
  | { kind: "schedule" }
  | { kind: "skill_maintenance" };

export interface ToolModelPolicyContext {
  sessionId?: string;
  operationMode?: SessionOperationMode;
}

export interface ToolModelRequirement {
  tier: "small" | "large";
  reason: string;
  policy: ToolModelPolicy["kind"] | "undeclared";
}

const descriptions: Record<ToolModelPolicy["kind"], string> = {
  observe: "查询或观察已授权的信息与状态，可使用小模型。",
  bounded_content: "处理当前任务、明确数据对象或受限临时工作区内的内容，可使用小模型。",
  execution: "执行命令、代码或交互输入，或控制进程与运行环境，使用大模型。",
  filesystem: "访问宿主机通用文件路径使用大模型；明确传入受限临时工作区时可使用小模型。",
  asset_or_filesystem: "处理已登记资源可使用小模型；直接读取宿主机文件路径使用大模型。",
  browser_interaction: "页面观察与导航可使用小模型；不能确认仅为查询的页面交互使用大模型。",
  persistent_policy: "改变权限、账号状态、长期执行规则或自动化策略，使用大模型。",
  external_effect: "对其他主体、其他会话或外部服务产生额外影响，使用大模型。",
  schedule: "当前会话的一次性明确提醒可使用小模型；重复或跨会话自动执行使用大模型。",
  skill_maintenance: "暂存当前技能配置草稿可使用小模型；修改正式技能或其执行策略使用大模型。"
};

// These are browser protocol actions, not semantic guesses based on page text.
// Generic click/type/press may submit or mutate state, even without action=submit.
const browserObservationActions = new Set([
  "hover", "scroll_down", "scroll_up", "wait", "go_back", "go_forward", "reload"
]);

export function describeToolModelPolicy(policy: ToolModelPolicy | undefined): string {
  return policy ? descriptions[policy.kind] : "操作影响范围尚未声明，使用大模型核查。";
}

/** This selects a model floor; authorization and actual resource validation still run. */
export function resolveToolModelRequirement(
  descriptor: Pick<ToolDescriptor, "modelPolicy">,
  args: unknown,
  context: ToolModelPolicyContext = {}
): ToolModelRequirement {
  const policy = descriptor.modelPolicy;
  if (!policy) return { tier: "large", reason: describeToolModelPolicy(undefined), policy: "undeclared" };
  const values = objectArgs(args);
  const result = (tier: "small" | "large", reason = descriptions[policy.kind]): ToolModelRequirement => ({ tier, reason, policy: policy.kind });
  switch (policy.kind) {
    case "observe":
    case "bounded_content":
      return result("small");
    case "execution":
    case "persistent_policy":
    case "external_effect":
      return result("large");
    case "filesystem":
      // Only declare this policy for operations routed through the workspace
      // scope wrapper. A false/expired/foreign ID is rejected by that service.
      return typeof values.workspace_id === "string" && values.workspace_id.trim().length > 0
        ? result("small", "操作限定在临时工作区；实际范围与访问权由工作区服务校验。")
        : result("large", "操作访问宿主机通用文件路径。");
    case "asset_or_filesystem":
      return Object.prototype.hasOwnProperty.call(values, policy.pathParameter)
        ? result("large", "本次操作直接使用宿主机文件路径。")
        : result("small", "本次操作只处理已登记资源。");
    case "browser_interaction":
      return typeof values.action === "string" && browserObservationActions.has(values.action)
        ? result("small", "本次操作仅观察页面或进行浏览导航。")
        : result("large", "页面交互可能提交信息或改变外部状态，需要大模型核查。");
    case "schedule": {
      const schedule = objectArgs(values.schedule);
      const targets = values.sessionIds;
      const sameSession = Boolean(context.sessionId) && Array.isArray(targets)
        && targets.length === 1 && targets[0] === context.sessionId;
      return sameSession && (schedule.kind === "delay" || schedule.kind === "at")
        ? result("small", "创建仅发往当前会话的一次性任务；触发时另行校验实际操作。")
        : result("large", "本次计划任务涉及重复、跨会话或未明确范围的自动执行。");
    }
    case "skill_maintenance":
      return context.operationMode?.kind === "skill_config"
        ? result("small", "当前技能配置阶段只暂存草稿，正式发布仍需用户确认。")
        : result("large", "本次操作修改正式技能或其长期执行策略。");
  }
}

function objectArgs(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
