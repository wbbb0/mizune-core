import type { AppConfig } from "#config/config.ts";
import type { SessionState, InternalTranscriptItem } from "./sessionTypes.ts";
import type { MediaResolution } from "#services/workspace/mediaSources/types.ts";
import { resolvePendingMediaParts } from "#services/workspace/mediaSources/content.ts";
import { collectContentPartMediaIds, walkMessageContentParts } from "#messages/contentParts.ts";
import { transcriptMessageContentPartsSchema } from "./transcriptContract.ts";
import { freezeTranscriptItem } from "./immutableTranscript.ts";
import { withEstimatedInputTokenStats } from "./transcriptTokenStats.ts";
import { dedupeResolvedChatAttachments } from "#services/workspace/chatAttachments.ts";

export function applySessionMediaResolution(session: SessionState, resolution: MediaResolution, config: AppConfig): boolean {
  const resolutions = new Map([[resolution.ref, resolution]]);
  const patch = (message: { contentParts?: import("#messages/contentParts.ts").MessageContentPart[] | undefined }) => {
    if (![...walkMessageContentParts(message.contentParts)].some(part => (part.kind === "pending_media" && part.mediaRef === resolution.ref) || ((part.kind === "image" || part.kind === "emoji" || part.kind === "asset_file") && part.mediaRef === resolution.ref && part.fileId !== resolution.file.fileId))) return null;
    const oldIds = [...walkMessageContentParts(message.contentParts)].flatMap(part =>
      (part.kind === "image" || part.kind === "emoji" || part.kind === "asset_file") && part.mediaRef === resolution.ref && part.fileId !== resolution.file.fileId ? [part.fileId!] : []);
    const contentParts = transcriptMessageContentPartsSchema.parse(resolvePendingMediaParts(message.contentParts ?? [], resolutions));
    return { oldIds, contentParts, imageIds: collectContentPartMediaIds(contentParts, "image"), emojiIds: collectContentPartMediaIds(contentParts, "emoji") };
  };
  const attachment = { fileId: resolution.file.fileId, kind: resolution.file.kind, source: "chat_message" as const,
    sourceName: resolution.file.sourceName, mimeType: resolution.file.mimeType,
    ...(resolution.kind === "image" || resolution.kind === "emoji" ? { semanticKind: resolution.kind } : {}) };
  let changed = false;
  const changedIds = new Set<string>();
  session.internalTranscript = session.internalTranscript.map(item => {
    if (item.kind !== "user_message" && item.kind !== "user_media_message") return item;
    const replacement = patch(item);
    if (!replacement) return item;
    const { oldIds, ...fields } = replacement;
    changed = true;
    if (item.id) changedIds.add(item.id);
    return freezeTranscriptItem(withEstimatedInputTokenStats({ ...item, ...fields,
      attachments: dedupeResolvedChatAttachments([...(item.attachments ?? []).filter(attachment => !oldIds.includes(attachment.fileId)), attachment]) } as InternalTranscriptItem, config));
  });
  const patchPending = (message: SessionState["pendingMessages"][number]) => {
    const replacement = patch(message);
    if (!replacement) return message;
    const { oldIds, ...fields } = replacement;
    return { ...message, ...fields, attachments: dedupeResolvedChatAttachments([...(message.attachments ?? []).filter(attachment => !oldIds.includes(attachment.fileId)), attachment]) };
  };
  session.pendingMessages = session.pendingMessages.map(patchPending);
  session.pendingSteerMessages = session.pendingSteerMessages.map(patchPending);
  for (const queued of session.queuedGroupReplyTargets) queued.messages = queued.messages.map(patchPending);
  if (changed) {
    session.historyRevision += 1;
    if (session.publishedConversation?.messages.some(message => changedIds.has(message.id))) session.publishedConversation = null;
  }
  return changed;
}
