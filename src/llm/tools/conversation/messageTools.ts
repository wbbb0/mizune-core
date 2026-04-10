import {
  extractFileSources,
  extractForwardIds,
  extractMentions,
  extractReplyMessageId,
  extractText,
  normalizeSegmentsForTool
} from "#services/onebot/messageSegments.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { resolveMessageIdArg } from "../core/structuredIdResolver.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";

export const messageToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "view_message",
        description: "按 prompt 里的精确 message_id 展开一条引用消息，返回正文、回复引用、提及、image ids 和 forward ids。",
        parameters: {
          type: "object",
          properties: {
            message_id: { type: "string" }
          },
          required: ["message_id"],
          additionalProperties: false
        }
      }
    }
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
      const workspaceFileAssets = await Promise.all(
        extractFileSources(message.message).map(async (item) => context.chatFileStore.importRemoteSource({
          source: item.source,
          kind: "file",
          origin: "chat_message",
          ...(item.filename ? { sourceName: item.filename } : {}),
          ...(item.mimeType ? { mimeType: item.mimeType } : {})
        }).catch(() => null))
      );
      let imageIndex = 0;
      const mentions = extractMentions(message.message);
      const sender = message.sender ?? {};
      const senderName = getFirstNonEmptyString([
        sender.card,
        sender.nickname,
        message.user_id
      ]) || "unknown";

      return JSON.stringify({
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
          })),
          ...workspaceFileAssets.filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => ({
            fileId: item.fileId,
            kind: item.kind,
            sourceName: item.sourceName,
            mimeType: item.mimeType
          }))
        ],
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
      });
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
};

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
