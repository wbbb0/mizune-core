import {
  type ExtractedFileSource,
  extractFileSources,
  extractForwardIds,
  extractMentions,
  extractReplyMessageId,
  extractText,
  normalizeSegmentsForTool
} from "#services/onebot/messageSegments.ts";
import { importOneBotMessageFile } from "#services/onebot/fileSourceImport.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { resolveMessageIdArg } from "../core/structuredIdResolver.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { buildChatFileHandleResultFromContext } from "../core/chatFileHandle.ts";
import { projectToolResult, type JsonObject } from "../core/toolResultProjection.ts";

export const messageToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "view_message",
        description: "按 prompt 里的精确 message_id 展开一条引用消息，返回正文、回复引用、提及、image ids、forward ids 和消息文件提示。不会自动下载文件。",
        parameters: {
          type: "object",
          properties: {
            message_id: { type: "string" }
          },
          required: ["message_id"],
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
        name: "download_message_file",
        description: "按聊天消息里显示的 file_id 下载该消息文件并登记为 asset。私聊和群聊文件都使用这个工具；只有确实需要读取、查看或发送文件内容时才调用。",
        parameters: {
          type: "object",
          properties: {
            file_id: { type: "string" },
            busid: { type: "string" },
            source_name: { type: "string" },
            mime_type: { type: "string" }
          },
          required: ["file_id"],
          additionalProperties: false
        }
      }
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
  }
];

export const messageToolHandlers: Record<string, ToolHandler> = {
  async view_message(toolCall, args, context) {
    const requestedMessageId = getStringArg(args, "message_id");
    const messageId = resolveMessageIdArg(requestedMessageId, toolCall.function.arguments, context);
    if (!messageId) {
      return JSON.stringify({ error: "message_id is required" });
    }

    try {
      const message = await context.oneBotClient.getMessage(messageId);
      const normalizedSegments = normalizeSegmentsForTool(message.message);
      const imageSources = normalizedSegments.flatMap((segment) => (
        segment.kind === "image"
          ? [{ source: segment.source, kind: segment.mediaKind }]
          : []
      ));
      const workspaceImageAssets = await Promise.all(
        imageSources
          .map(async (item) => context.chatFileStore.importRemoteSource({
            source: item.source,
            kind: "image",
            origin: "chat_message",
            sourceContext: {
              mediaKind: item.kind
            }
          }).catch(() => null))
      );
      const fileSources = extractFileSources(message.message);
      let imageIndex = 0;
      const mentions = extractMentions(message.message);
      const sender = message.sender ?? {};
      const senderName = getFirstNonEmptyString([
        sender.card,
        sender.nickname,
        message.user_id
      ]) || "unknown";

      const canonical = {
        ok: true,
        messageId,
        resolvedMessageId: message.message_id != null ? String(message.message_id) : null,
        chatType: message.message_type ?? null,
        senderName,
        userId: message.user_id != null ? String(message.user_id) : null,
        groupId: message.group_id != null ? String(message.group_id) : null,
        ...(message.time != null ? { time: message.time, timeText: formatTimestamp(message.time) } : {}),
        text: extractText(message.message).trim(),
        replyMessageId: extractReplyMessageId(message.message),
        mentions: {
          mentionedSelf: mentions.mentionedSelf,
          mentionedAll: mentions.mentionedAll,
          userIds: mentions.userIds
        },
        forwardIds: extractForwardIds(message.message),
        attachments: [
          ...workspaceImageAssets.filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => ({
            fileId: item.fileId,
            kind: item.kind,
            sourceName: item.sourceName,
            mimeType: item.mimeType,
            semanticKind: item.sourceContext.mediaKind === "emoji" ? "emoji" : "image"
          }))
        ],
        files: fileSources.map(formatExtractedFileSource),
        segments: normalizedSegments.map((segment) => {
          if (segment.kind === "image") {
            const registered = workspaceImageAssets[imageIndex];
            imageIndex += 1;
            return {
              kind: segment.kind,
              mediaKind: segment.mediaKind,
              fileId: registered?.fileId ?? null,
              viewable: Boolean(registered)
            };
          }
          if (segment.kind === "mention") {
            return {
              kind: segment.kind,
              target: segment.target,
              ...(segment.userId ? { userId: segment.userId } : {})
            };
          }
          if (segment.kind === "forward") {
            return {
              kind: segment.kind,
              forwardId: segment.forwardId
            };
          }
          if (segment.kind === "reply") {
            return {
              kind: segment.kind,
              messageId: segment.messageId
            };
          }
          if (segment.kind === "file") {
            return {
              kind: segment.kind,
              fileId: segment.fileId,
              filename: segment.filename,
              busid: segment.busid,
              sizeBytes: segment.sizeBytes,
              mimeType: segment.mimeType,
              downloadTool: "download_message_file",
              summary: segment.summary
            };
          }
          if (segment.kind === "text") {
            return {
              kind: segment.kind,
              text: segment.text
            };
          }
          return {
            kind: segment.kind,
            type: segment.type,
            summary: segment.summary
          };
        })
      };
      return projectToolResult({
        toolName: "view_message",
        canonical: canonical as unknown as JsonObject,
        args: args as Record<string, unknown>,
        projection: {
          initial: (item) => ({
            ok: item.ok,
            messageId: item.messageId,
            resolvedMessageId: item.resolvedMessageId,
            chatType: item.chatType,
            senderName: item.senderName,
            userId: item.userId,
            groupId: item.groupId,
            timeText: item.timeText,
            text: item.text,
            replyMessageId: item.replyMessageId,
            mentions: item.mentions,
            forwardIds: item.forwardIds,
            attachments: item.attachments,
            files: item.files,
            segments: item.segments,
            summary: `消息 ${String(item.messageId)} 已展开，图片 asset 与消息文件下载入口已列出。`
          })
        }
      });
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  },

  async download_message_file(_toolCall, args, context) {
    const fileId = getStringArg(args, "file_id") || getStringArg(args, "fileId");
    if (!fileId) {
      return JSON.stringify({ error: "file_id is required" });
    }
    const busid = getStringArg(args, "busid") || null;
    const sourceName = getStringArg(args, "source_name") || getStringArg(args, "sourceName") || null;
    const mimeType = getStringArg(args, "mime_type") || getStringArg(args, "mimeType") || null;
    const parsedSession = parseChatSessionIdentity(context.lastMessage.sessionId);
    const groupId = parsedSession?.kind === "group" ? parsedSession.groupId : null;
    const file = await importOneBotMessageFile({
      fileSource: {
        sourceKind: "onebot_file",
        fileId,
        busid,
        filename: sourceName,
        mimeType,
        sizeBytes: null
      },
      chatFileStore: context.chatFileStore,
      oneBotClient: context.oneBotClient,
      origin: "chat_message",
      groupId,
      userId: context.lastMessage.userId,
      senderName: context.lastMessage.senderName
    });
    if (!file) {
      return JSON.stringify({
        error: "message file download failed",
        file_id: fileId,
        ...(busid ? { busid } : {})
      });
    }
    const fileHandle = buildChatFileHandleResultFromContext(file, context);
    const canonical = {
      ok: true,
      ...fileHandle,
      asset_id: file.fileId,
      asset_ref: file.fileRef,
      ...(groupId ? { group_id: groupId } : {}),
      onebot_file_id: fileId,
      ...(busid ? { busid } : {})
    };
    return projectToolResult({
      toolName: "download_message_file",
      canonical: canonical as unknown as JsonObject,
      args: args as Record<string, unknown>,
      projection: {
        initial: (item) => ({
          ok: item.ok,
          asset_id: item.asset_id,
          asset_ref: item.asset_ref,
          asset_handle: item.asset_handle,
          onebot_file_id: item.onebot_file_id,
          group_id: item.group_id,
          busid: item.busid,
          next_actions: item.next_actions,
          summary: `消息文件 ${String(item.onebot_file_id)} 已登记为 asset ${String(item.asset_ref ?? item.asset_id)}。`
        })
      }
    });
  }
};

function formatExtractedFileSource(fileSource: ExtractedFileSource): Record<string, unknown> {
  return fileSource.sourceKind === "direct"
    ? {
        sourceKind: fileSource.sourceKind,
        fileId: fileSource.fileId,
        busid: fileSource.busid,
        filename: fileSource.filename,
        mimeType: fileSource.mimeType,
        sizeBytes: fileSource.sizeBytes
      }
    : {
        sourceKind: fileSource.sourceKind,
        fileId: fileSource.fileId,
        busid: fileSource.busid,
        filename: fileSource.filename,
        mimeType: fileSource.mimeType,
        sizeBytes: fileSource.sizeBytes
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

function getFirstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}
