import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { requireOwner } from "../core/shared.ts";

export const whitelistToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "search_friends",
        description: "按用户 ID、昵称或备注搜索已添加好友，供白名单操作前确认。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          additionalProperties: false
        }
      }
    }
  },
  {
    definition: {
      type: "function",
      function: {
        name: "search_joined_groups",
        description: "按群号或群名搜索已加入的群，供白名单操作前确认。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
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
        name: "set_chat_permission",
        description: "设置聊天白名单权限。targetType=user 或 group，allowed=true 加入白名单，allowed=false 移出白名单。",
        parameters: {
          type: "object",
          properties: {
            targetType: {
              type: "string",
              enum: ["user", "group"]
            },
            targetId: { type: "string" },
            allowed: { type: "boolean" }
          },
          required: ["targetType", "targetId", "allowed"],
          additionalProperties: false
        }
      }
    }
  }
];

export const whitelistToolHandlers: Record<string, ToolHandler> = {
  async search_friends(_toolCall, args, context) {
    const query = typeof args === "object" && args && "query" in args
      ? String((args as { query: unknown }).query).trim().toLowerCase()
      : "";
    const friends = await context.oneBotClient.getFriendList();
    return JSON.stringify(
      friends
        .filter((item) => {
          if (!query) {
            return true;
          }
          return [
            String(item.user_id),
            String(item.nickname ?? ""),
            String(item.remark ?? "")
          ].some((value) => value.toLowerCase().includes(query));
        })
        .slice(0, 20)
        .map((item) => ({
          user_id: String(item.user_id),
          nickname: item.nickname ?? null,
          remark: item.remark ?? null
        }))
    );
  },
  async search_joined_groups(_toolCall, args, context) {
    const query = typeof args === "object" && args && "query" in args
      ? String((args as { query: unknown }).query).trim().toLowerCase()
      : "";
    const groups = await context.oneBotClient.getGroupList();
    return JSON.stringify(
      groups
        .filter((item) => {
          if (!query) {
            return true;
          }
          return [
            String(item.group_id),
            String(item.group_name ?? "")
          ].some((value) => value.toLowerCase().includes(query));
        })
        .slice(0, 20)
        .map((item) => ({
          groupId: String(item.group_id),
          groupName: item.group_name ?? null,
          memberCount: item.member_count ?? null
        }))
    );
  },
  async set_chat_permission(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update chat whitelist");
    if (denied) {
      return denied;
    }
    const targetType = typeof args === "object" && args && "targetType" in args
      ? String((args as { targetType: unknown }).targetType).trim()
      : "";
    const targetId = typeof args === "object" && args && "targetId" in args
      ? String((args as { targetId: unknown }).targetId).trim()
      : "";
    const allowed = typeof args === "object" && args && "allowed" in args
      ? (args as { allowed: unknown }).allowed
      : undefined;
    if (!["user", "group"].includes(targetType)) {
      return JSON.stringify({ error: "targetType must be user or group" });
    }
    if (!targetId) {
      return JSON.stringify({ error: "targetId is required" });
    }
    if (typeof allowed !== "boolean") {
      return JSON.stringify({ error: "allowed must be boolean" });
    }

    if (targetType === "user") {
      const users = allowed
        ? await context.whitelistStore.addUser(targetId)
        : await context.whitelistStore.removeUser(targetId);
      return JSON.stringify({
        targetType,
        targetId,
        allowed,
        whitelistUsers: users
      });
    }
    const groups = allowed
      ? await context.whitelistStore.addGroup(targetId)
      : await context.whitelistStore.removeGroup(targetId);
    return JSON.stringify({
      targetType,
      targetId,
      allowed,
      whitelistGroups: groups
    });
  }
};
