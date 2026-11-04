import { hasConnectorCapability } from "#services/messaging/connectorCapabilities.ts";
import { assertKnownOneBotReference } from "#services/onebot/referenceAccess.ts";
import { mediaScopeForSession, resolvePendingMediaParts } from "#services/workspace/mediaSources/content.ts";
import { importReferenceMedia } from "#services/onebot/referenceMedia.ts";
import { foldForwardRecords, decodeNativeForwardRecordRef } from "#messages/forwardRecords.ts";
import { walkMessageContentParts } from "#messages/contentParts.ts";
import { readCachedForwardRecord, pageForwardRecord, FORWARD_PAGE_LIMIT } from "#services/messaging/forwardRecordReader.ts";
import type { ToolDescriptor, ToolHandler } from "../core/shared.ts";
import { getStringArg } from "../core/toolArgHelpers.ts";
import { keepRawUnlessLargePolicy } from "../core/resultObservationPresets.ts";

export const forwardToolDescriptors: ToolDescriptor[] = [{
  definition: { type: "function", function: {
    name: "view_forward_record",
    description: "在当前会话按 record_ref 分页展开转发记录。每段最多1000字，默认10段、最多20段；嵌套记录保持折叠。图片仅返回资产引用，不自动发给视觉API；先读正文，再选少量相关图片用 asset_media_view 查看。",
    parameters: { type: "object", properties: {
      record_ref: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: FORWARD_PAGE_LIMIT }
    }, required: ["record_ref"], additionalProperties: false }
  } }, resultObservation: keepRawUnlessLargePolicy({ preserveRecentRawCount: 1 })
}];

export const forwardToolHandlers: Record<string, ToolHandler> = {
  async view_forward_record(_toolCall, args, context) {
    const ref = getStringArg(args, "record_ref");
    const values = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
    const offset = values.offset ?? 0, limit = values.limit ?? 10;
    if (!Number.isInteger(offset) || Number(offset) < 0 || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > FORWARD_PAGE_LIMIT) {
      return JSON.stringify({ error: "offset 必须是非负整数，limit 必须是1至20的整数" });
    }
    try {
      const scope = mediaScopeForSession(context.lastMessage.sessionId);
      let parts;
      let truncated = false;
      if (ref.startsWith("record_")) {
        const record = readCachedForwardRecord(context.sessionManager.getSession(scope.sessionId).internalTranscript, ref);
        parts = record.parts;
        truncated = record.truncated === true;
      } else {
        const nativeId = decodeNativeForwardRecordRef(ref);
        if (!nativeId || !hasConnectorCapability(context.config, { sessionId: context.lastMessage.sessionId }, "message.read_native")) throw new Error("当前会话没有该转发记录的可用来源");
        assertKnownOneBotReference(context.sessionManager, scope.sessionId, "forward", nativeId);
        const expanded = await context.oneBotReferenceResolver.expand(scope, [{ kind: "forward", forwardId: nativeId }]);
        const record = expanded.find(part => part.kind === "embedded_message" && part.relation === "forward");
        if (!record || record.kind !== "embedded_message") throw new Error("平台暂未提供该转发记录，请稍后再试");
        const imported = await importReferenceMedia(context, context.lastMessage, record.parts);
        parts = foldForwardRecords(imported.contentParts, { nativeReferences: true });
        truncated = record.truncated === true;
      }
      const page = pageForwardRecord(parts, Number(offset), Number(limit));
      const refs = new Set([...walkMessageContentParts(page.contentParts)].flatMap(part =>
        (part.kind === "pending_media" || part.kind === "image" || part.kind === "emoji" || part.kind === "asset_file") && part.mediaRef ? [part.mediaRef] : []));
      const resolutions = new Map<string, import("#services/workspace/mediaSources/types.ts").MediaResolution>();
      await Promise.all([...refs].slice(0, 16).map(async mediaRef => {
        const result = await context.mediaImportService.resolve(scope, mediaRef, context.abortSignal);
        if (result) resolutions.set(mediaRef, result);
      }));
      const contentParts = resolvePendingMediaParts(page.contentParts, resolutions);
      const fileIds = [...new Set([...walkMessageContentParts(contentParts)].flatMap(part =>
        (part.kind === "image" || part.kind === "emoji" || part.kind === "asset_file") && part.fileId ? [part.fileId] : []))];
      const files = fileIds.length ? await context.chatFileStore.getMany(fileIds) : [];
      return JSON.stringify({ ok: true, recordRef: ref, offset, limit, totalSegments: page.totalSegments, nextOffset: page.nextOffset,
        truncated, source: "user_provided", contentParts, assets: files.map(file => ({ asset_id: file.fileId, asset_ref: file.fileRef, kind: file.kind, source_name: file.sourceName, mime_type: file.mimeType })),
        mediaPolicy: "本页图片仅列出资产引用，未调用识图、图片描述或转写；请按需挑选少量相关资产查看。" });
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  }
};
