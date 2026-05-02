import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOwner } from "../core/shared.ts";
import { keepRawUnlessLargePolicy, stateChangePolicy } from "../core/resultObservationPresets.ts";

export const requestToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "list_pending_friend_requests",
        description: "列出缓存中的待处理好友请求。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
  },
  {
    definition: {
      type: "function",
      function: {
        name: "list_pending_group_requests",
        description: "列出缓存中的待处理加群或邀请请求。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "respond_request",
        description: "处理请求审批。kind=friend 时可选 remark；kind=group 时可选 reason。",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["friend", "group"]
            },
            approve: { type: "boolean" },
            flag: { type: "string" },
            remark: { type: "string" },
            reason: { type: "string" }
          },
          required: ["kind", "approve", "flag"],
          additionalProperties: false
        }
      }
    },
    resultObservation: stateChangePolicy()
  }
];

export const requestToolHandlers: Record<string, ToolHandler> = {
  async list_pending_friend_requests(_toolCall, _args, context) {
    return JSON.stringify(await context.requestStore.listFriendRequests());
  },
  async list_pending_group_requests(_toolCall, _args, context) {
    return JSON.stringify(await context.requestStore.listGroupRequests());
  },
  async respond_request(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can respond to requests");
    if (denied) {
      return denied;
    }
    const kind = typeof args === "object" && args && "kind" in args
      ? String((args as { kind: unknown }).kind).trim()
      : "";
    const approve = typeof args === "object" && args && "approve" in args
      ? (args as { approve: unknown }).approve
      : undefined;
    const flag = typeof args === "object" && args && "flag" in args
      ? String((args as { flag: unknown }).flag).trim()
      : "";
    const remark = typeof args === "object" && args && "remark" in args
      ? String((args as { remark: unknown }).remark).trim()
      : "";
    const reason = typeof args === "object" && args && "reason" in args
      ? String((args as { reason: unknown }).reason).trim()
      : "";
    if (!["friend", "group"].includes(kind)) {
      return JSON.stringify({ error: "kind must be friend or group" });
    }
    if (typeof approve !== "boolean") {
      return JSON.stringify({ error: "approve must be boolean" });
    }
    if (!flag) {
      return JSON.stringify({ error: "flag is required" });
    }
    const request = await context.requestStore.get(flag);
    if (!request || request.kind !== kind) {
      return JSON.stringify({ error: `Pending ${kind} request not found` });
    }
    if (kind === "friend") {
      const result = await context.oneBotClient.setFriendAddRequest({
        flag,
        approve,
        ...((remark || reason) ? { remark: remark || reason } : {})
      });
      await context.requestStore.remove(flag);
      return JSON.stringify({ ok: true, result });
    }

    if (request.kind !== "group") {
      return JSON.stringify({ error: "Pending group request not found" });
    }
    const result = await context.oneBotClient.setGroupAddRequest({
      flag,
      subType: request.subType,
      approve,
      ...((reason || remark) ? { reason: reason || remark } : {})
    });
    await context.requestStore.remove(flag);
    return JSON.stringify({ ok: true, result });
  }
};
