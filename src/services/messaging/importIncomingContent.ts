import type { ParsedIncomingMessage } from "#services/messaging/incomingMessage.ts";
import { collectContentPartMediaIds, collectContentPartAttachments, walkMessageContentParts, type MessageContentPart, type PersistedMessageContentPart, type MessageMediaContentPart } from "#messages/contentParts.ts";
import { marketFaceSourceContext } from "#services/onebot/messageSegments.ts";
import { dedupeResolvedChatAttachments, isPendingChatAttachmentId } from "#services/workspace/chatAttachments.ts";
import { mediaScopeForSession, mediaResolutionPart } from "#services/workspace/mediaSources/content.ts";
import { buildSessionId } from "#conversation/session/sessionIdentity.ts";
import type { AudioStore } from "#audio/audioStore.ts";
import type { MediaImportService } from "#services/workspace/mediaSources/service.ts";
import type { ChatFileRecord } from "#services/workspace/types.ts";

type Services = { audioStore: Pick<AudioStore, "registerSources">; mediaImportService: Pick<MediaImportService, "import"> };
type ImportedAsset = ChatFileRecord;

/** Resolve assets in place within quoted trees; nested authors never become the current actor. */
export async function importIncomingContent(
  services: Services, message: ParsedIncomingMessage, userId: string
) {
  const contentParts = [...(message.contentParts ?? [])];
  if (!contentParts.length && message.text) contentParts.push({ kind: "text", text: message.text });
  const leaves = [...walkMessageContentParts(contentParts)].filter(part => part.kind !== "embedded_message");
  const images = leaves.filter((part): part is MessageMediaContentPart & { source: string } =>
    (part.kind === "image" || part.kind === "emoji") && typeof part.source === "string" && Boolean(part.source.trim()));
  if (!images.length) {
    const extra = message.images.map(source => ({ kind: message.emojiSources.includes(source) ? "emoji" as const : "image" as const, source }));
    images.push(...extra); contentParts.push(...extra);
  }
  const remoteFiles = leaves.filter((part): part is Extract<MessageContentPart, { kind: "remote_file" }> => part.kind === "remote_file");
  for (const file of message.remoteAttachments ?? []) {
    if (!remoteFiles.some(part => part.source === file.source)) {
      const part: Extract<MessageContentPart, { kind: "remote_file" }> = { kind: "remote_file", source: file.source,
        sourceName: file.sourceName, mimeType: file.mimeType, fileKind: file.kind };
      remoteFiles.push(part); contentParts.push(part);
    }
  }
  const sources = [...new Set([...message.audioSources,
    ...leaves.flatMap(part => part.kind === "audio" && part.source ? [part.source] : [])])];
  for (const source of message.audioSources) {
    if (!leaves.some(part => part.kind === "audio" && part.source === source)) contentParts.push({ kind: "audio", source });
  }
  const scope = mediaScopeForSession(buildSessionId(message));
  let rootImageIndex = 0;
  for (const part of images) {
    if (!part.mediaLocator && message.rawEvent?.message_id != null && message.source !== "qq_official") {
      part.mediaLocator = { kind: "onebot_message", id: String(message.rawEvent.message_id), imageIndex: rootImageIndex++ };
    }
  }
  const [audios, imageResults, fileResults] = await Promise.all([
    services.audioStore.registerSources(sources),
    Promise.all(images.map(async part => ({ part, imported: await services.mediaImportService.import(scope, {
      kind: part.kind, source: part.source, sourceName: part.sourceName, mimeType: part.mimeType,
      locator: part.mediaLocator,
      sourceContext: { ...marketFaceSourceContext(part.marketFace), userId, senderName: message.senderName }
    }) }))),
    Promise.all(remoteFiles.map(async part => ({ part, imported: await services.mediaImportService.import(scope, {
      kind: part.fileKind, source: part.source, sourceName: part.sourceName, mimeType: part.mimeType,
      sourceContext: { userId, senderName: message.senderName }
    }) })))
  ]);
  const replacements = new Map<MessageContentPart, PersistedMessageContentPart>();
  const importedImages: Array<{ part: MessageMediaContentPart; asset: ImportedAsset }> = [];
  const importedFiles: ImportedAsset[] = [];
  for (const { part, imported } of imageResults) {
    if (imported.resolution) {
      importedImages.push({ part, asset: imported.resolution.file });
      replacements.set(part, mediaResolutionPart(imported.resolution));
    } else replacements.set(part, { kind: "pending_media", mediaRef: imported.ref, mediaKind: part.kind, sourceName: part.sourceName ?? null });
  }
  for (const { part, imported } of fileResults) {
    if (imported.resolution) {
      importedFiles.push(imported.resolution.file);
      replacements.set(part, mediaResolutionPart(imported.resolution));
    } else replacements.set(part, { kind: "pending_media", mediaRef: imported.ref, mediaKind: part.fileKind, sourceName: part.sourceName });
  }
  const audioBySource = new Map(audios.map(audio => [audio.source, audio.id]));
  function resolve(parts: readonly MessageContentPart[]): PersistedMessageContentPart[] {
    return parts.map(part => {
      if (part.kind === "embedded_message") return { ...part, parts: resolve(part.parts) };
      const replacement = replacements.get(part);
      if (replacement) return replacement;
      if (part.kind === "audio" && part.source) {
        const audioId = audioBySource.get(part.source);
        return audioId ? { kind: "audio", audioId } : { kind: "special", segmentType: "unavailable_media", summary: "语音导入失败。" };
      }
      if (part.kind === "remote_file") return { kind: "special", segmentType: "unavailable_media", summary: `文件导入失败：${part.sourceName}` };
      return part;
    });
  }
  const resolvedParts = resolve(contentParts);
  return {
    contentParts: resolvedParts,
    audioSources: sources, audioIds: audios.map(audio => audio.id),
    imageIds: [...new Set([...message.imageIds.filter(id => !isPendingChatAttachmentId(id)), ...collectContentPartMediaIds(resolvedParts, "image"),
      ...importedImages.filter(item => item.part.kind === "image").map(item => item.asset.fileId)])],
    emojiIds: [...new Set([...message.emojiIds.filter(id => !isPendingChatAttachmentId(id)), ...collectContentPartMediaIds(resolvedParts, "emoji"),
      ...importedImages.filter(item => item.part.kind === "emoji").map(item => item.asset.fileId)])],
    attachments: dedupeResolvedChatAttachments([...(message.attachments ?? []),
      ...importedFiles.map(asset => ({ fileId: asset.fileId, kind: asset.kind, source: "chat_message" as const,
        sourceName: asset.sourceName, mimeType: asset.mimeType })),
      ...importedImages.map(({part,asset}) => ({ fileId: asset.fileId, kind: asset.kind, source: "chat_message" as const,
        sourceName: asset.sourceName, mimeType: asset.mimeType, semanticKind: part.kind })),
      ...collectContentPartAttachments(resolvedParts)])
  };
}
