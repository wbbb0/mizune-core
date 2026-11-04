import { assertKnownOneBotReference } from "#services/onebot/referenceAccess.ts";
import { mediaScopeForSession } from "#services/workspace/mediaSources/content.ts";
import { importReferenceMedia } from "#services/onebot/referenceMedia.ts";
import { buildChatFileHandleResultFromContext } from "../core/fileHandle.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { resolveForwardIdArg } from "../core/structuredIdResolver.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";

export const forwardToolDescriptors: ToolDescriptor[] = [
  {
    requiresOneBot: true,
    definition: {
      type: "function",
      function: {
        name: "view_forward_record",
        description: "按 prompt 里的精确 forward_id 展开一条合并转发记录，递归返回记录层级，并补下载其中图片，返回真实 asset 句柄。",
        parameters: {
          type: "object",
          properties: {
            forward_id: { type: "string" }
          },
          required: ["forward_id"],
          additionalProperties: false
        }
      }
    },
    resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
  }
];

export const forwardToolHandlers: Record<string, ToolHandler> = {
  async view_forward_record(toolCall, args, context) {
    const requestedForwardId = getStringArg(args, "forward_id");
    const forwardId = resolveForwardIdArg(requestedForwardId, toolCall.function.arguments, context);
    if (!forwardId) {
      return JSON.stringify({ error: "forward_id is required" });
    }

    try {
      assertKnownOneBotReference(context.sessionManager, context.lastMessage.sessionId, "forward", forwardId);
      const parts = await context.oneBotReferenceResolver.expand(mediaScopeForSession(context.lastMessage.sessionId), [{ kind: "forward", forwardId }]);
      const imported = await importReferenceMedia(context, context.lastMessage, parts);
      const files = await context.chatFileStore.getMany([...imported.imageIds, ...imported.emojiIds]);
      return JSON.stringify({ ok: true, forwardId, contentParts: imported.contentParts,
        assets: files.map(file => buildChatFileHandleResultFromContext(file, context)),
        summary: "转发内容已按层级展开，图片已登记为可查看的资产；未完成的媒体保留可重试引用。" });
    } catch (error: unknown) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
};
