import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOwner } from "../core/shared.ts";

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
    }
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
    }
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "approve_friend_request",
        description: "按 flag 同意好友请求，可选设置 remark。",
        parameters: {
          type: "object",
          properties: {
            flag: { type: "string" },
            remark: { type: "string" }
          },
          required: ["flag"],
          additionalProperties: false
        }
      }
    }
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "reject_friend_request",
        description: "按 flag 拒绝好友请求。",
        parameters: {
          type: "object",
          properties: {
            flag: { type: "string" }
          },
          required: ["flag"],
          additionalProperties: false
        }
      }
    }
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "approve_group_request",
        description: "按 flag 同意加群或邀请请求。",
        parameters: {
          type: "object",
          properties: {
            flag: { type: "string" },
            reason: { type: "string" }
          },
          required: ["flag"],
          additionalProperties: false
        }
      }
    }
  },
  {
    ownerOnly: true,
    definition: {
      type: "function",
      function: {
        name: "reject_group_request",
        description: "按 flag 拒绝加群或邀请请求，可选填写 reason。",
        parameters: {
          type: "object",
          properties: {
            flag: { type: "string" },
            reason: { type: "string" }
          },
          required: ["flag"],
          additionalProperties: false
        }
      }
    }
  }
];

export const requestToolHandlers: Record<string, ToolHandler> = {
  async list_pending_friend_requests(_toolCall, _args, context) {
    return JSON.stringify(await context.requestStore.listFriendRequests());
  },
  async list_pending_group_requests(_toolCall, _args, context) {
    return JSON.stringify(await context.requestStore.listGroupRequests());
  },
  async approve_friend_request(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can approve friend requests");
    if (denied) {
      return denied;
    }
    const flag = typeof args === "object" && args && "flag" in args
      ? String((args as { flag: unknown }).flag).trim()
      : "";
    const remark = typeof args === "object" && args && "remark" in args
      ? String((args as { remark: unknown }).remark).trim()
      : "";
    if (!flag) {
      return JSON.stringify({ error: "flag is required" });
    }
    const request = await context.requestStore.get(flag);
    if (!request || request.kind !== "friend") {
      return JSON.stringify({ error: "Pending friend request not found" });
    }
    const result = await context.oneBotClient.setFriendAddRequest({
      flag,
      approve: true,
      ...(remark ? { remark } : {})
    });
    await context.requestStore.remove(flag);
    return JSON.stringify({ ok: true, result });
  },
  async reject_friend_request(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can reject friend requests");
    if (denied) {
      return denied;
    }
    const flag = typeof args === "object" && args && "flag" in args
      ? String((args as { flag: unknown }).flag).trim()
      : "";
    if (!flag) {
      return JSON.stringify({ error: "flag is required" });
    }
    const request = await context.requestStore.get(flag);
    if (!request || request.kind !== "friend") {
      return JSON.stringify({ error: "Pending friend request not found" });
    }
    const result = await context.oneBotClient.setFriendAddRequest({
      flag,
      approve: false
    });
    await context.requestStore.remove(flag);
    return JSON.stringify({ ok: true, result });
  },
  async approve_group_request(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can approve group requests");
    if (denied) {
      return denied;
    }
    const flag = typeof args === "object" && args && "flag" in args
      ? String((args as { flag: unknown }).flag).trim()
      : "";
    const reason = typeof args === "object" && args && "reason" in args
      ? String((args as { reason: unknown }).reason).trim()
      : "";
    if (!flag) {
      return JSON.stringify({ error: "flag is required" });
    }
    const request = await context.requestStore.get(flag);
    if (!request || request.kind !== "group") {
      return JSON.stringify({ error: "Pending group request not found" });
    }
    const result = await context.oneBotClient.setGroupAddRequest({
      flag,
      subType: request.subType,
      approve: true,
      ...(reason ? { reason } : {})
    });
    await context.requestStore.remove(flag);
    return JSON.stringify({ ok: true, result });
  },
  async reject_group_request(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can reject group requests");
    if (denied) {
      return denied;
    }
    const flag = typeof args === "object" && args && "flag" in args
      ? String((args as { flag: unknown }).flag).trim()
      : "";
    const reason = typeof args === "object" && args && "reason" in args
      ? String((args as { reason: unknown }).reason).trim()
      : "";
    if (!flag) {
      return JSON.stringify({ error: "flag is required" });
    }
    const request = await context.requestStore.get(flag);
    if (!request || request.kind !== "group") {
      return JSON.stringify({ error: "Pending group request not found" });
    }
    const result = await context.oneBotClient.setGroupAddRequest({
      flag,
      subType: request.subType,
      approve: false,
      ...(reason ? { reason } : {})
    });
    await context.requestStore.remove(flag);
    return JSON.stringify({ ok: true, result });
  }
};
