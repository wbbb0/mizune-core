import { MODEL_SELF_UPGRADE_TOOL_NAME, resolveModelSelfUpgradePlan } from "#llm/shared/modelSelfUpgrade.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { stateChangePolicy } from "../core/resultObservationPresets.ts";

export const modelRoutingToolDescriptors: ToolDescriptor[] = [{
  definition: {
    type: "function",
    function: {
      name: MODEL_SELF_UPGRADE_TOOL_NAME,
      description: "将本轮后续工作切换到能力更强的完整模型。适用于任务本身或新证据已表明当前模型难以可靠处理的情况；不能补充工具、权限或外部事实。",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "简述已知任务要求或新证据暴露的复杂性。",
            maxLength: 200
          }
        },
        required: ["reason"],
        additionalProperties: false
      }
    }
  },
  isEnabled: (config, options) => resolveModelSelfUpgradePlan({
    config,
    currentModelRefs: options?.modelRef ?? [],
    enabled: true
  }) != null,
  isVisible: (context) => context.modelSelfUpgradeAvailable === true,
  resultObservation: stateChangePolicy()
}];

export const modelRoutingToolHandlers: Record<string, ToolHandler> = {
  async [MODEL_SELF_UPGRADE_TOOL_NAME](_toolCall, args, context) {
    if (!context.modelRoutingAccess) {
      return JSON.stringify({
        ok: false,
        upgraded: false,
        reason: null,
        message: "当前轮次不允许切换模型路由。"
      });
    }
    const reason = getStringArg(args, "reason").slice(0, 200);
    if (!reason) {
      return JSON.stringify({
        ok: false,
        upgraded: false,
        reason: null,
        message: "reason 不能为空。"
      });
    }
    return JSON.stringify(context.modelRoutingAccess.requestModelUpgrade(reason));
  }
};
