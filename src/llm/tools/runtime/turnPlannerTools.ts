import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg, getStringArrayArg } from "../core/toolArgHelpers.ts";

export const turnPlannerToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "list_available_toolsets",
        description: "列出当前回合可申请的工具集及其说明。发现缺失工具时应先调用本工具。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "request_toolset",
        description: "申请启用一个或多个工具集。每轮最多允许一次升级申请；审批通过后再调用对应工具。",
        parameters: {
          type: "object",
          properties: {
            toolset_ids: {
              type: "array",
              items: { type: "string" },
              minItems: 1
            },
            reason: { type: "string" }
          },
          required: ["toolset_ids"],
          additionalProperties: false
        }
      }
    }
  }
];

export const turnPlannerToolHandlers: Record<string, ToolHandler> = {
  async list_available_toolsets(_toolCall, _args, context) {
    if (!context.toolsetAccess) {
      return JSON.stringify({ error: "toolset access is not available in this turn" });
    }
    return JSON.stringify(context.toolsetAccess.listAvailableToolsets());
  },
  async request_toolset(_toolCall, args, context) {
    if (!context.toolsetAccess) {
      return JSON.stringify({ error: "toolset access is not available in this turn" });
    }
    const toolsetIds = getStringArrayArg(args, "toolset_ids") ?? [];
    const reason = getStringArg(args, "reason") ?? "";
    if (toolsetIds.length === 0) {
      return JSON.stringify({ error: "toolset_ids is required" });
    }
    return JSON.stringify(context.toolsetAccess.requestToolsets(toolsetIds, reason));
  }
};
