import type { ParsedIncomingMessage } from "#services/messaging/incomingMessage.ts";
import { walkMessageContentParts, type MessageContentPart, type PersistedMessageContentPart, type MessageMediaContentPart } from "#messages/contentParts.ts";
import { marketFaceSourceContext } from "#services/onebot/messageSegments.ts";
import { dedupeResolvedChatAttachments, isPendingChatAttachmentId } from "#services/workspace/chatAttachments.ts";
import type { MessageHandlerServices } from "./messageHandlerTypes.ts";

type Services = Pick<MessageHandlerServices, "audioStore" | "chatFileStore">;
type ImportedAsset = Awaited<ReturnType<Services["chatFileStore"]["importRemoteSource"]>>;

/** Resolve assets in place within quoted trees; nested authors never become the current actor. */
export async function importIncomingContent(
  services: Services, message: ParsedIncomingMessage, userId: string
) {
  const leaves = [...walkMessageContentParts(message.contentParts)].filter(part => part.kind !== "embedded_message");
  const images = leaves.filter((part): part is MessageMediaContentPart & { source: string } =>
    (part.kind === "image" || part.kind === "emoji") && typeof part.source === "string" && Boolean(part.source.trim()));
  if (!images.length) {
    images.push(...message.images.map(source => ({ kind: message.emojiSources.includes(source) ? "emoji" as const : "image" as const, source })));
  }
  const remoteFiles = leaves.filter((part): part is Extract<MessageContentPart, { kind: "remote_file" }> => part.kind === "remote_file");
  for (const file of message.remoteAttachments ?? []) {
    if (!remoteFiles.some(part => part.source === file.source)) remoteFiles.push({ kind: "remote_file", source: file.source,
      sourceName: file.sourceName, mimeType: file.mimeType, fileKind: file.kind });
  }
  const sources = [...new Set([...message.audioSources,
    ...leaves.flatMap(part => part.kind === "audio" && part.source ? [part.source] : [])])];
  const [audios, imageResults, fileResults] = await Promise.all([
    services.audioStore.registerSources(sources),
    Promise.all(images.map(async part => ({ part, asset: await services.chatFileStore.importRemoteSource({
      source: part.source, kind: "image", origin: "chat_message",
      sourceContext: { mediaKind: part.kind, ...marketFaceSourceContext(part.marketFace), userId, senderName: message.senderName }
    }).catch(() => null) }))),
    Promise.all(remoteFiles.map(async part => ({ part, asset: await services.chatFileStore.importRemoteSource({
      source: part.source, sourceName: part.sourceName, mimeType: part.mimeType, kind: part.fileKind, origin: "chat_message",
      sourceContext: { userId, senderName: message.senderName }
    }).catch(() => null) })))
  ]);
  const replacements = new Map<MessageContentPart, PersistedMessageContentPart>();
  const importedImages: Array<{ part: MessageMediaContentPart; asset: ImportedAsset }> = [];
  const importedFiles: ImportedAsset[] = [];
  for (const {part, asset} of imageResults) {
    if (asset) {
      importedImages.push({ part, asset });
      replacements.set(part, { kind: part.kind, fileId: asset.fileId, sourceName: asset.sourceName, mimeType: asset.mimeType });
    } else replacements.set(part, { kind: "special", segmentType: "unavailable_media", summary: part.kind === "emoji" ? "表情导入失败。" : "图片导入失败。" });
  }
  for (const {part, asset} of fileResults) {
    if (asset) {
      importedFiles.push(asset);
      replacements.set(part, { kind: "asset_file", fileId: asset.fileId, fileKind: asset.kind,
        sourceName: asset.sourceName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes });
    } else replacements.set(part, { kind: "special", segmentType: "unavailable_media", summary: `文件导入失败：${part.sourceName}` });
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
  return {
    contentParts: resolve(message.contentParts ?? []),
    audioSources: sources, audioIds: audios.map(audio => audio.id),
    imageIds: [...new Set([...message.imageIds.filter(id => !isPendingChatAttachmentId(id)),
      ...importedImages.filter(item => item.part.kind === "image").map(item => item.asset.fileId)])],
    emojiIds: [...new Set([...message.emojiIds.filter(id => !isPendingChatAttachmentId(id)),
      ...importedImages.filter(item => item.part.kind === "emoji").map(item => item.asset.fileId)])],
    attachments: dedupeResolvedChatAttachments([...(message.attachments ?? []),
      ...importedFiles.map(asset => ({ fileId: asset.fileId, kind: asset.kind, source: "chat_message" as const,
        sourceName: asset.sourceName, mimeType: asset.mimeType })),
      ...importedImages.map(({part,asset}) => ({ fileId: asset.fileId, kind: asset.kind, source: "chat_message" as const,
        sourceName: asset.sourceName, mimeType: asset.mimeType, semanticKind: part.kind }))])
  };
}
