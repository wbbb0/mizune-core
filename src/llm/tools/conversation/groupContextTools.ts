import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import type {
  OneBotGroupAnnouncementItem,
  OneBotGroupFileItem,
  OneBotGroupFolderItem,
  OneBotGroupMemberItem
} from "#services/onebot/types.ts";
import type { BuiltinToolContext, ToolDescriptor, ToolHandler, ToolVisibilityContext } from "../core/shared.ts";
import { getNumberArg, getStringArg } from "../core/toolArgHelpers.ts";
import { currentGroupContextPolicy } from "../core/resultObservationPresets.ts";
import { buildChatFileHandleResultFromContext } from "../core/chatFileHandle.ts";
import { projectToolResult, type JsonObject } from "../core/toolResultProjection.ts";

const DEFAULT_ANNOUNCEMENT_LIMIT = 10;
const MAX_ANNOUNCEMENT_LIMIT = 30;
const DEFAULT_ANNOUNCEMENT_LINE_COUNT = 80;
const MAX_ANNOUNCEMENT_LINE_COUNT = 200;
const DEFAULT_MEMBER_LIMIT = 20;
const MAX_MEMBER_LIMIT = 50;
const DEFAULT_GROUP_FILE_LIMIT = 30;
const MAX_GROUP_FILE_LIMIT = 100;
const MAX_ANNOUNCEMENT_CONTENT_LENGTH = 1200;
const MAX_ANNOUNCEMENT_DETAIL_CHARS = 8000;

export const groupContextToolDescriptors: ToolDescriptor[] = [
  {
    isVisible: isVisibleInCurrentOneBotGroupChat,
    definition: {
      type: "function",
      function: {
        name: "view_current_group_info",
        description: "查看当前群聊的资料。只能在群聊会话内使用，不接受 groupId；NapCat 会尽量附带扩展群资料和 @全体剩余次数。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    resultObservation: currentGroupContextPolicy()
  },
  {
    isVisible: isVisibleInCurrentOneBotGroupChat,
    definition: {
      type: "function",
      function: {
        name: "list_current_group_files",
        description: "列出当前群文件目录，可传 folderId 查看子目录，可按文件名、目录名、上传者过滤。只能在当前群聊内使用，不接受 groupId。",
        parameters: {
          type: "object",
          properties: {
            folderId: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" }
          },
          additionalProperties: false
        }
      }
    },
    resultObservation: currentGroupContextPolicy()
  },
  {
    isVisible: isVisibleInCurrentOneBotGroupChat,
    isEnabled: (config) => config.chatFiles.enabled,
    definition: {
      type: "function",
      function: {
        name: "download_current_group_file",
        description: "下载当前群文件并登记为 asset。必须传 fileId 和 busid；短下载直接返回 asset_handle，长下载返回 download resource_id 并在完成后内部回调。只能在当前群聊内使用，不接受 groupId。",
        parameters: {
          type: "object",
          properties: {
            fileId: { type: "string" },
            busid: { type: "number" },
            sourceName: { type: "string" },
            kind: { type: "string", enum: ["image", "animated_image", "video", "audio", "file"] }
          },
          required: ["fileId", "busid"],
          additionalProperties: false
        }
      }
    },
    resultObservation: currentGroupContextPolicy()
  },
  {
    isVisible: isVisibleInCurrentOneBotGroupChat,
    definition: {
      type: "function",
      function: {
        name: "list_current_group_announcements",
        description: "查看当前群公告列表，可按标题、内容、发布者过滤。返回公告 ID、序号和内容预览；需要公告全文时调用 view_current_group_announcement。只能在当前群聊内使用，不接受 groupId。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" }
          },
          additionalProperties: false
        }
      }
    },
    resultObservation: currentGroupContextPolicy()
  },
  {
    isVisible: isVisibleInCurrentOneBotGroupChat,
    definition: {
      type: "function",
      function: {
        name: "view_current_group_announcement",
        description: "按公告 ID 或列表序号查看当前群单条公告全文片段。支持 startLine 和 lineCount，行号从 1 开始；结果会按长度截断并给出下一段起始行。只能在当前群聊内使用，不接受 groupId。",
        parameters: {
          type: "object",
          properties: {
            announcementId: { type: "string" },
            announcementIndex: { type: "number" },
            query: { type: "string" },
            startLine: { type: "number" },
            startChar: { type: "number" },
            lineCount: { type: "number" }
          },
          additionalProperties: false
        }
      }
    },
    resultObservation: currentGroupContextPolicy()
  },
  {
    isVisible: isVisibleInCurrentOneBotGroupChat,
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
    },
    resultObservation: currentGroupContextPolicy()
  }
];

function isVisibleInCurrentOneBotGroupChat(context: ToolVisibilityContext): boolean {
  if (!context.sessionId) {
    return true;
  }
  if (context.replyDelivery === "web") {
    return false;
  }
  const parsed = parseChatSessionIdentity(context.sessionId);
  return parsed?.kind === "group" && parsed.source === "onebot";
}

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
    const napcatDetails = context.config.onebot.provider === "napcat"
      ? await loadNapCatGroupDetails(context, groupId)
      : { extended: null, atAllRemain: null, warnings: [] };
    const canonical = {
      ok: true,
      groupId,
      groupName,
      memberCount,
      maxMemberCount,
      provider: context.config.onebot.provider,
      extended: napcatDetails.extended,
      atAllRemain: napcatDetails.atAllRemain,
      ...(napcatDetails.warnings.length > 0 ? { warnings: napcatDetails.warnings } : {}),
      summary: [
        `当前群 ${groupName} (${groupId})`,
        memberCount != null ? `成员 ${memberCount}` : null,
        maxMemberCount != null ? `上限 ${maxMemberCount}` : null,
        napcatDetails.atAllRemain?.remain_at_all_count_for_group != null
          ? `本群 @全体剩余 ${napcatDetails.atAllRemain.remain_at_all_count_for_group}`
          : null,
        napcatDetails.extended ? "包含 NapCat 扩展资料" : null
      ].filter((item): item is string => Boolean(item)).join("，"),
      raw: compactRecord(info, ["group_id", "group_name", "member_count", "max_member_count"])
    };
    return projectToolResult({
      toolName: "view_current_group_info",
      canonical: canonical as unknown as JsonObject,
      projection: {
        initial: (item) => ({
          ok: item.ok,
          groupId: item.groupId,
          groupName: item.groupName,
          memberCount: item.memberCount,
          maxMemberCount: item.maxMemberCount,
          provider: item.provider,
          extended: item.extended,
          atAllRemain: item.atAllRemain,
          warnings: item.warnings,
          summary: item.summary
        })
      }
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
    const items = filtered.slice(0, limit).map((item, index) => ({
      announcementIndex: index + 1,
      ...stripSearchText(item)
    }));
    const canonical = {
      ok: true,
      groupId,
      query: query || null,
      limit,
      count: items.length,
      totalMatched: filtered.length,
      totalAnnouncements: announcements.length,
      summary: `当前群 ${groupId} 公告查询返回 ${items.length}/${filtered.length} 条，limit=${limit}${query ? `，query="${query}"` : ""}`,
      items
    };
    return projectToolResult({
      toolName: "list_current_group_announcements",
      canonical: canonical as unknown as JsonObject,
      args: args as Record<string, unknown>,
      projection: { initial: compactGroupListProjection }
    });
  },

  async view_current_group_announcement(_toolCall, args, context) {
    const groupId = resolveCurrentGroupId(context);
    if (!groupId) {
      return JSON.stringify({ error: "current session is not a group chat" });
    }

    const announcementId = getStringArg(args, "announcementId");
    const announcementIndex = getPositiveIntegerArg(args, "announcementIndex");
    const query = getStringArg(args, "query");
    const startLine = getPositiveIntegerArg(args, "startLine") ?? 1;
    const startChar = getNonNegativeIntegerArg(args, "startChar") ?? 0;
    const lineCount = clampPositiveInteger(
      getNumberArg(args, "lineCount"),
      DEFAULT_ANNOUNCEMENT_LINE_COUNT,
      MAX_ANNOUNCEMENT_LINE_COUNT
    );
    if (!announcementId && !announcementIndex) {
      return JSON.stringify({ error: "announcementId or announcementIndex is required", groupId });
    }

    const announcements = (await context.oneBotClient.getGroupAnnouncements(groupId))
      .map(normalizeAnnouncementRecord);
    const filtered = filterByQuery(announcements, query);
    const selected = announcementId
      ? filtered.find((item) => item.id === announcementId)
      : filtered[announcementIndex! - 1];
    if (!selected) {
      return JSON.stringify({
        error: "Announcement not found",
        groupId,
        announcementId: announcementId || null,
        announcementIndex: announcementIndex ?? null,
        query: query || null,
        totalMatched: filtered.length,
        totalAnnouncements: announcements.length
      });
    }

    const contentView = sliceTextByLines(selected.content, startLine, startChar, lineCount, MAX_ANNOUNCEMENT_DETAIL_CHARS);
    const canonical = {
      ok: true,
      groupId,
      announcementId: selected.id,
      announcementIndex: filtered.indexOf(selected) + 1,
      query: query || null,
      title: selected.title,
      senderId: selected.senderId,
      senderName: selected.senderName,
      publishTime: selected.publishTime,
      publishTimeText: selected.publishTimeText,
      pinned: selected.pinned,
      contentLength: selected.content.length,
      totalLines: contentView.totalLines,
      startLine: contentView.startLine,
      startChar: contentView.startChar,
      requestedLineCount: lineCount,
      endLine: contentView.endLine,
      nextStartLine: contentView.nextStartLine,
      nextStartChar: contentView.nextStartChar,
      lineTruncated: contentView.lineTruncated,
      charTruncated: contentView.charTruncated,
      content: contentView.content,
      summary: [
        `当前群 ${groupId} 公告 ${selected.id ?? `#${filtered.indexOf(selected) + 1}`}`,
        selected.title ? `标题「${selected.title}」` : null,
        `行 ${contentView.startLine}-${contentView.endLine}/${contentView.totalLines}`,
        contentView.nextStartLine ? `可从 startLine=${contentView.nextStartLine} 继续` : null
      ].filter((item): item is string => Boolean(item)).join("，")
    };
    return projectToolResult({
      toolName: "view_current_group_announcement",
      canonical: canonical as unknown as JsonObject,
      args: args as Record<string, unknown>,
      projection: {
        initial: (item) => ({
          ok: item.ok,
          groupId: item.groupId,
          announcementId: item.announcementId,
          announcementIndex: item.announcementIndex,
          query: item.query,
          title: item.title,
          senderId: item.senderId,
          senderName: item.senderName,
          publishTimeText: item.publishTimeText,
          pinned: item.pinned,
          contentLength: item.contentLength,
          totalLines: item.totalLines,
          startLine: item.startLine,
          startChar: item.startChar,
          requestedLineCount: item.requestedLineCount,
          endLine: item.endLine,
          nextStartLine: item.nextStartLine,
          nextStartChar: item.nextStartChar,
          lineTruncated: item.lineTruncated,
          charTruncated: item.charTruncated,
          content: item.content,
          summary: item.summary
        })
      }
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
    const canonical = {
      ok: true,
      groupId,
      query: query || null,
      limit,
      count: items.length,
      totalMatched: filtered.length,
      totalMembers: members.length,
      summary: `当前群 ${groupId} 成员查询返回 ${items.length}/${filtered.length} 人，limit=${limit}${query ? `，query="${query}"` : ""}`,
      items
    };
    return projectToolResult({
      toolName: "list_current_group_members",
      canonical: canonical as unknown as JsonObject,
      args: args as Record<string, unknown>,
      projection: { initial: compactGroupListProjection }
    });
  },

  async list_current_group_files(_toolCall, args, context) {
    const groupId = resolveCurrentGroupId(context);
    if (!groupId) {
      return JSON.stringify({ error: "current session is not a group chat" });
    }

    const folderId = getStringArg(args, "folderId");
    const query = getStringArg(args, "query");
    const limit = getLimitArg(args, DEFAULT_GROUP_FILE_LIMIT, MAX_GROUP_FILE_LIMIT);
    const result = folderId
      ? await context.oneBotClient.getGroupFilesByFolder(groupId, folderId)
      : await context.oneBotClient.getGroupRootFiles(groupId);
    const folders = result.folders.map(normalizeGroupFolder);
    const files = result.files.map(normalizeGroupFile);
    const filteredFolders = filterByQuery(folders, query);
    const filteredFiles = filterByQuery(files, query);
    const combined = [
      ...filteredFolders.map((item) => ({ type: "folder" as const, item })),
      ...filteredFiles.map((item) => ({ type: "file" as const, item }))
    ].slice(0, limit);

    const canonical = {
      ok: true,
      groupId,
      folderId: folderId || null,
      query: query || null,
      limit,
      folders: combined.filter((entry) => entry.type === "folder").map((entry) => stripSearchText(entry.item)),
      files: combined.filter((entry) => entry.type === "file").map((entry) => stripSearchText(entry.item)),
      totalFolders: folders.length,
      totalFiles: files.length,
      totalMatchedFolders: filteredFolders.length,
      totalMatchedFiles: filteredFiles.length,
      summary: `当前群 ${groupId} 文件目录返回 ${combined.length}/${filteredFolders.length + filteredFiles.length} 项，folderId=${folderId || "root"}${query ? `，query="${query}"` : ""}`
    };
    return projectToolResult({
      toolName: "list_current_group_files",
      canonical: canonical as unknown as JsonObject,
      args: args as Record<string, unknown>,
      projection: {
        initial: (item) => ({
          ok: item.ok,
          groupId: item.groupId,
          folderId: item.folderId,
          query: item.query,
          limit: item.limit,
          folders: Array.isArray(item.folders) ? item.folders.slice(0, 12) : [],
          files: Array.isArray(item.files) ? item.files.slice(0, 20) : [],
          totalFolders: item.totalFolders,
          totalFiles: item.totalFiles,
          totalMatchedFolders: item.totalMatchedFolders,
          totalMatchedFiles: item.totalMatchedFiles,
          summary: item.summary
        })
      }
    });
  },

  async download_current_group_file(_toolCall, args, context) {
    const groupId = resolveCurrentGroupId(context);
    if (!groupId) {
      return JSON.stringify({ error: "current session is not a group chat" });
    }

    const fileId = getStringArg(args, "fileId");
    const busid = getNumberArg(args, "busid");
    const sourceName = getStringArg(args, "sourceName");
    const kind = getStringArg(args, "kind") as "image" | "animated_image" | "video" | "audio" | "file" | "";
    if (!fileId || busid == null) {
      return JSON.stringify({ error: "fileId and busid are required", groupId });
    }
    const url = await context.oneBotClient.getGroupFileUrl(groupId, fileId, busid);
    if (!url?.url) {
      return JSON.stringify({ error: "Group file url not found", groupId, fileId, busid });
    }
    const result = await context.downloadRuntime.start({
      sourceUrl: url.url,
      ...(sourceName ? { sourceName } : {}),
      ...(kind ? { kind } : {}),
      origin: "group_file_download",
      proxyConsumer: "browser",
      owner: {
        sessionId: context.lastMessage.sessionId,
        userId: context.lastMessage.userId,
        senderName: context.lastMessage.senderName
      },
      sourceContext: {
        group_id: groupId,
        group_file_id: fileId,
        busid
      }
    });
    const file = result.file_id ? await context.chatFileStore.getFile(result.file_id) : null;
    const fileHandle = file ? buildChatFileHandleResultFromContext(file, context) : null;
    const canonical = {
      ok: true,
      groupId,
      groupFileId: fileId,
      group_file_id: fileId,
      busid,
      status: result.status,
      resource_id: result.resource_id,
      ...(fileHandle ?? {}),
      asset_ref: file?.fileRef ?? result.asset_ref ?? result.file_ref ?? null,
      source_url: result.source_url,
      downloaded_bytes: result.downloaded_bytes,
      total_bytes: result.total_bytes,
      percent: result.percent,
      error: result.error,
      ...(result.background_followup ? { background_followup: result.background_followup } : {})
    };
    return projectToolResult({
      toolName: "download_current_group_file",
      canonical: canonical as unknown as JsonObject,
      args: args as Record<string, unknown>,
      projection: {
        initial: (item) => ({
          ok: item.ok,
          groupId: item.groupId,
          groupFileId: item.groupFileId,
          group_file_id: item.group_file_id,
          busid: item.busid,
          status: item.status,
          resource_id: item.resource_id,
          asset_ref: item.asset_ref,
          asset_handle: item.asset_handle,
          next_actions: item.next_actions,
          downloaded_bytes: item.downloaded_bytes,
          total_bytes: item.total_bytes,
          percent: item.percent,
          error: item.error,
          background_followup: item.background_followup,
          summary: `当前群文件 ${String(item.groupFileId)} 下载 ${String(item.status ?? "已返回")}${item.asset_ref ? `，asset=${String(item.asset_ref)}` : ""}。`
        })
      }
    });
  }
};

function resolveCurrentGroupId(context: BuiltinToolContext): string | null {
  const parsed = parseChatSessionIdentity(context.lastMessage.sessionId);
  return parsed?.kind === "group" ? parsed.groupId : null;
}

function compactGroupListProjection(item: JsonObject): JsonObject {
  return {
    ok: item.ok,
    groupId: item.groupId,
    query: item.query,
    limit: item.limit,
    count: item.count,
    totalMatched: item.totalMatched,
    totalAnnouncements: item.totalAnnouncements,
    totalMembers: item.totalMembers,
    items: Array.isArray(item.items) ? item.items.slice(0, 20) : [],
    summary: item.summary
  };
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

function getPositiveIntegerArg(args: unknown, key: string): number | null {
  const value = getNumberArg(args, key);
  return Number.isFinite(value) && value != null && value > 0 ? Math.floor(value) : null;
}

function getNonNegativeIntegerArg(args: unknown, key: string): number | null {
  const value = getNumberArg(args, key);
  return Number.isFinite(value) && value != null && value >= 0 ? Math.floor(value) : null;
}

function clampPositiveInteger(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (!Number.isFinite(value) || value == null || value <= 0) {
    return defaultValue;
  }
  return Math.max(1, Math.min(maxValue, Math.floor(value)));
}

async function loadNapCatGroupDetails(context: BuiltinToolContext, groupId: string): Promise<{
  extended: Record<string, unknown> | null;
  atAllRemain: Record<string, unknown> | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const [extendedResult, atAllRemainResult] = await Promise.allSettled([
    context.oneBotClient.getGroupInfoEx(groupId),
    context.oneBotClient.getGroupAtAllRemain(groupId)
  ]);
  if (extendedResult.status === "rejected") {
    warnings.push(`get_group_info_ex failed: ${errorMessage(extendedResult.reason)}`);
  }
  if (atAllRemainResult.status === "rejected") {
    warnings.push(`get_group_at_all_remain failed: ${errorMessage(atAllRemainResult.reason)}`);
  }
  return {
    extended: extendedResult.status === "fulfilled" && extendedResult.value
      ? compactRecord(extendedResult.value, ["group_id", "group_name", "member_count", "max_member_count"])
      : null,
    atAllRemain: atAllRemainResult.status === "fulfilled" && atAllRemainResult.value
      ? compactRecord(atAllRemainResult.value, [])
      : null,
    warnings
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeAnnouncement(raw: OneBotGroupAnnouncementItem) {
  const normalized = normalizeAnnouncementRecord(raw);
  const compactContent = compactText(normalized.content, MAX_ANNOUNCEMENT_CONTENT_LENGTH);
  return {
    id: normalized.id,
    title: normalized.title,
    content: compactContent,
    contentLength: normalized.content.length,
    contentTruncated: compactContent.length < normalized.content.length,
    senderId: normalized.senderId,
    senderName: normalized.senderName,
    publishTime: normalized.publishTime,
    publishTimeText: normalized.publishTimeText,
    pinned: normalized.pinned,
    searchText: normalized.searchText
  };
}

function normalizeAnnouncementRecord(raw: OneBotGroupAnnouncementItem) {
  const id = stringValue(raw.id ?? raw.notice_id ?? raw.fid);
  const senderId = stringValue(raw.sender_id ?? raw.user_id ?? raw.publisher_id);
  const senderName = stringValue(raw.sender_name ?? raw.nickname ?? raw.publisher_name);
  const title = stringValue(raw.title);
  const content = stringValue(raw.content ?? raw.message ?? raw.text) ?? "";
  const publishTime = numberValue(raw.publish_time ?? raw.time ?? raw.create_time);
  return {
    id,
    title,
    content,
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

function normalizeGroupFile(raw: OneBotGroupFileItem) {
  const fileId = stringValue(raw.file_id ?? raw.id) ?? "";
  const fileName = stringValue(raw.file_name ?? raw.name) ?? fileId;
  const busid = raw.busid ?? raw.bus_id ?? null;
  const uploaderId = stringValue(raw.uploader ?? raw.uploader_id ?? raw.user_id);
  const uploaderName = stringValue(raw.uploader_name ?? raw.nickname);
  return {
    fileId,
    fileName,
    busid,
    sizeBytes: numberValue(raw.file_size ?? raw.size),
    uploadTime: numberValue(raw.upload_time ?? raw.time),
    deadTime: numberValue(raw.dead_time),
    modifyTime: numberValue(raw.modify_time),
    downloadTimes: numberValue(raw.download_times),
    uploaderId,
    uploaderName,
    searchText: [
      fileId,
      fileName,
      stringValue(busid),
      uploaderId,
      uploaderName
    ].filter((item): item is string => Boolean(item)).join("\n")
  };
}

function normalizeGroupFolder(raw: OneBotGroupFolderItem) {
  const folderId = stringValue(raw.folder_id ?? raw.id) ?? "";
  const folderName = stringValue(raw.folder_name ?? raw.name) ?? folderId;
  const creatorId = stringValue(raw.creator ?? raw.creator_id ?? raw.user_id);
  const creatorName = stringValue(raw.creator_name ?? raw.nickname);
  return {
    folderId,
    folderName,
    createTime: numberValue(raw.create_time ?? raw.time),
    creatorId,
    creatorName,
    totalFileCount: numberValue(raw.total_file_count ?? raw.file_count),
    searchText: [
      folderId,
      folderName,
      creatorId,
      creatorName
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

function sliceTextByLines(value: string, startLineInput: number, startCharInput: number, lineCount: number, maxChars: number) {
  const lines = value.split(/\r\n|\r|\n/);
  const totalLines = lines.length;
  const startLine = Math.max(1, Math.min(startLineInput, Math.max(totalLines, 1)));
  const startIndex = startLine - 1;
  const startChar = Math.max(0, Math.floor(startCharInput));
  const requestedEndIndex = Math.min(totalLines, startIndex + lineCount);
  const chunks: string[] = [];
  let usedChars = 0;
  let endLine = startLine;
  let nextStartLine: number | null = requestedEndIndex < totalLines ? requestedEndIndex + 1 : null;
  let nextStartChar: number | null = null;
  let charTruncated = false;

  for (let index = startIndex; index < requestedEndIndex; index += 1) {
    const originalLine = lines[index] ?? "";
    const charOffset = index === startIndex ? Math.min(startChar, originalLine.length) : 0;
    const line = originalLine.slice(charOffset);
    const prefixLength = chunks.length > 0 ? 1 : 0;
    const remaining = maxChars - usedChars - prefixLength;
    if (remaining <= 0) {
      charTruncated = true;
      nextStartLine = index + 1;
      nextStartChar = charOffset;
      break;
    }
    if (line.length > remaining) {
      chunks.push(line.slice(0, remaining));
      usedChars = maxChars;
      endLine = index + 1;
      charTruncated = true;
      nextStartLine = index + 1;
      nextStartChar = charOffset + remaining;
      break;
    }
    if (prefixLength) {
      usedChars += 1;
    }
    chunks.push(line);
    usedChars += line.length;
    endLine = index + 1;
  }
  const lineTruncated = nextStartLine != null;
  return {
    content: chunks.join("\n"),
    totalLines,
    startLine,
    startChar,
    endLine,
    nextStartLine,
    nextStartChar,
    lineTruncated,
    charTruncated
  };
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
