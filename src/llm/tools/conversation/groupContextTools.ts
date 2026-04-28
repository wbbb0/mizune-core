import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import type { OneBotGroupAnnouncementItem, OneBotGroupMemberItem } from "#services/onebot/types.ts";
import type { BuiltinToolContext, ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";

const DEFAULT_ANNOUNCEMENT_LIMIT = 10;
const MAX_ANNOUNCEMENT_LIMIT = 30;
const DEFAULT_MEMBER_LIMIT = 20;
const MAX_MEMBER_LIMIT = 50;
const MAX_ANNOUNCEMENT_CONTENT_LENGTH = 1200;

export const groupContextToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "view_current_group_info",
        description: "查看当前群聊的基础信息。只能在群聊会话内使用，不接受 groupId。",
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
        name: "list_current_group_announcements",
        description: "查看当前群公告列表，可按标题、内容、发布者过滤。只能在当前群聊内使用，不接受 groupId。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" }
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
        name: "list_current_group_members",
        description: "查看当前群成员列表，可按用户 ID、昵称、群名片、头衔或角色过滤。只能在当前群聊内使用，不接受 groupId。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" }
          },
          additionalProperties: false
        }
      }
    }
  }
];

export const groupContextToolHandlers: Record<string, ToolHandler> = {
  async view_current_group_info(_toolCall, _args, context) {
    const groupId = resolveCurrentGroupId(context);
    if (!groupId) {
      return JSON.stringify({ error: "current session is not a group chat" });
    }

    const info = await context.oneBotClient.getGroupInfo(groupId);
    if (!info) {
      return JSON.stringify({ error: "Group info not found", groupId });
    }

    const groupName = stringValue(info.group_name) ?? groupId;
    const memberCount = numberValue(info.member_count);
    const maxMemberCount = numberValue(info.max_member_count);
    return JSON.stringify({
      ok: true,
      groupId,
      groupName,
      memberCount,
      maxMemberCount,
      summary: [
        `当前群 ${groupName} (${groupId})`,
        memberCount != null ? `成员 ${memberCount}` : null,
        maxMemberCount != null ? `上限 ${maxMemberCount}` : null
      ].filter((item): item is string => Boolean(item)).join("，"),
      raw: compactRecord(info, ["group_id", "group_name", "member_count", "max_member_count"])
    });
  },

  async list_current_group_announcements(_toolCall, args, context) {
    const groupId = resolveCurrentGroupId(context);
    if (!groupId) {
      return JSON.stringify({ error: "current session is not a group chat" });
    }

    const query = getStringArg(args, "query");
    const limit = getLimitArg(args, DEFAULT_ANNOUNCEMENT_LIMIT, MAX_ANNOUNCEMENT_LIMIT);
    const announcements = (await context.oneBotClient.getGroupAnnouncements(groupId))
      .map(normalizeAnnouncement);
    const filtered = filterByQuery(announcements, query);
    const items = filtered.slice(0, limit).map(stripSearchText);
    return JSON.stringify({
      ok: true,
      groupId,
      query: query || null,
      limit,
      count: items.length,
      totalMatched: filtered.length,
      totalAnnouncements: announcements.length,
      summary: `当前群 ${groupId} 公告查询返回 ${items.length}/${filtered.length} 条，limit=${limit}${query ? `，query="${query}"` : ""}`,
      items
    });
  },

  async list_current_group_members(_toolCall, args, context) {
    const groupId = resolveCurrentGroupId(context);
    if (!groupId) {
      return JSON.stringify({ error: "current session is not a group chat" });
    }

    const query = getStringArg(args, "query");
    const limit = getLimitArg(args, DEFAULT_MEMBER_LIMIT, MAX_MEMBER_LIMIT);
    const members = (await context.oneBotClient.getGroupMemberList(groupId))
      .map(normalizeMember);
    const filtered = filterByQuery(members, query);
    const items = filtered.slice(0, limit).map(stripSearchText);
    return JSON.stringify({
      ok: true,
      groupId,
      query: query || null,
      limit,
      count: items.length,
      totalMatched: filtered.length,
      totalMembers: members.length,
      summary: `当前群 ${groupId} 成员查询返回 ${items.length}/${filtered.length} 人，limit=${limit}${query ? `，query="${query}"` : ""}`,
      items
    });
  }
};

function resolveCurrentGroupId(context: BuiltinToolContext): string | null {
  const parsed = parseChatSessionIdentity(context.lastMessage.sessionId);
  return parsed?.kind === "group" ? parsed.groupId : null;
}

function getLimitArg(args: unknown, defaultLimit: number, maxLimit: number): number {
  const value = typeof args === "object" && args && "limit" in args
    ? Number((args as { limit: unknown }).limit)
    : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return defaultLimit;
  }
  return Math.max(1, Math.min(maxLimit, Math.floor(value)));
}

function normalizeAnnouncement(raw: OneBotGroupAnnouncementItem) {
  const id = stringValue(raw.id ?? raw.notice_id ?? raw.fid);
  const senderId = stringValue(raw.sender_id ?? raw.user_id ?? raw.publisher_id);
  const senderName = stringValue(raw.sender_name ?? raw.nickname ?? raw.publisher_name);
  const title = stringValue(raw.title);
  const content = stringValue(raw.content ?? raw.message ?? raw.text) ?? "";
  const publishTime = numberValue(raw.publish_time ?? raw.time ?? raw.create_time);
  const compactContent = compactText(content, MAX_ANNOUNCEMENT_CONTENT_LENGTH);
  return {
    id,
    title,
    content: compactContent,
    contentLength: content.length,
    contentTruncated: compactContent.length < content.length,
    senderId,
    senderName,
    publishTime,
    publishTimeText: publishTime != null ? formatTimestamp(publishTime) : null,
    pinned: booleanValue(raw.pinned ?? raw.is_pinned ?? raw.top),
    searchText: [
      id,
      title,
      content,
      senderId,
      senderName
    ].filter((item): item is string => Boolean(item)).join("\n")
  };
}

function normalizeMember(raw: OneBotGroupMemberItem) {
  const userId = stringValue(raw.user_id) ?? "";
  const nickname = stringValue(raw.nickname);
  const card = stringValue(raw.card);
  const title = stringValue(raw.title);
  const role = stringValue(raw.role);
  const displayName = card || nickname || userId;
  return {
    userId,
    displayName,
    nickname,
    card,
    role,
    title,
    level: stringValue(raw.level),
    joinTime: numberValue(raw.join_time),
    lastSentTime: numberValue(raw.last_sent_time),
    shutUpUntil: numberValue(raw.shut_up_timestamp),
    searchText: [
      userId,
      displayName,
      nickname,
      card,
      role,
      title,
      stringValue(raw.level)
    ].filter((item): item is string => Boolean(item)).join("\n")
  };
}

function filterByQuery<T extends { searchText: string }>(items: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return items;
  }
  return items.filter((item) => item.searchText.toLowerCase().includes(normalizedQuery));
}

function stripSearchText<T extends { searchText: string }>(item: T): Omit<T, "searchText"> {
  const { searchText: _searchText, ...rest } = item;
  return rest;
}

function compactRecord(record: Record<string, unknown>, excludedKeys: string[]): Record<string, unknown> {
  const excluded = new Set(excludedKeys);
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key, value]) => !excluded.has(key) && isPrimitive(value))
      .slice(0, 20)
  );
}

function isPrimitive(value: unknown): boolean {
  return value == null || ["string", "number", "boolean"].includes(typeof value);
}

function stringValue(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function numberValue(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? Math.floor(normalized) : null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "0"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function compactText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function formatTimestamp(timestampSeconds: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestampSeconds * 1000));
}
