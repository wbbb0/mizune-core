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
        name: "allow_user_chat",
        description: "把用户加入聊天白名单。",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string" }
          },
          required: ["user_id"],
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
        name: "disallow_user_chat",
        description: "把用户移出聊天白名单。",
        parameters: {
          type: "object",
          properties: {
            user_id: { type: "string" }
          },
          required: ["user_id"],
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
        name: "allow_group_chat",
        description: "把已加入的群加入群白名单。",
        parameters: {
          type: "object",
          properties: {
            groupId: { type: "string" }
          },
          required: ["groupId"],
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
        name: "disallow_group_chat",
        description: "把群移出群白名单。",
        parameters: {
          type: "object",
          properties: {
            groupId: { type: "string" }
          },
          required: ["groupId"],
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
  async allow_user_chat(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update user whitelist");
    if (denied) {
      return denied;
    }
    const userId = typeof args === "object" && args && "user_id" in args
      ? String((args as { user_id: unknown }).user_id).trim()
      : "";
    if (!userId) {
      return JSON.stringify({ error: "user_id is required" });
    }
    const users = await context.whitelistStore.addUser(userId);
    return JSON.stringify({ user_id: userId, whitelistUsers: users });
  },
  async disallow_user_chat(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update user whitelist");
    if (denied) {
      return denied;
    }
    const userId = typeof args === "object" && args && "user_id" in args
      ? String((args as { user_id: unknown }).user_id).trim()
      : "";
    if (!userId) {
      return JSON.stringify({ error: "user_id is required" });
    }
    const users = await context.whitelistStore.removeUser(userId);
    return JSON.stringify({ user_id: userId, whitelistUsers: users });
  },
  async allow_group_chat(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update group whitelist");
    if (denied) {
      return denied;
    }
    const groupId = typeof args === "object" && args && "groupId" in args
      ? String((args as { groupId: unknown }).groupId).trim()
      : "";
    if (!groupId) {
      return JSON.stringify({ error: "groupId is required" });
    }
    const groups = await context.whitelistStore.addGroup(groupId);
    return JSON.stringify({ groupId, whitelistGroups: groups });
  },
  async disallow_group_chat(_toolCall, args, context) {
    const denied = requireOwner(context.relationship, "Only owner can update group whitelist");
    if (denied) {
      return denied;
    }
    const groupId = typeof args === "object" && args && "groupId" in args
      ? String((args as { groupId: unknown }).groupId).trim()
      : "";
    if (!groupId) {
      return JSON.stringify({ error: "groupId is required" });
    }
    const groups = await context.whitelistStore.removeGroup(groupId);
    return JSON.stringify({ groupId, whitelistGroups: groups });
  }
};
