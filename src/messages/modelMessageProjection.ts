import { foldForwardRecords } from "#messages/forwardRecords.ts";
import { walkMessageContentParts } from "#messages/contentParts.ts";
import type { MessageContentPart } from "#messages/contentParts.ts";
import type { ChatAttachment } from "#services/workspace/types.ts";

interface ModelMediaMessage {
  contentParts?: MessageContentPart[] | undefined;
  images?: string[] | undefined; emojiSources?: string[] | undefined; imageIds?: string[] | undefined; emojiIds?: string[] | undefined;
  audioIds?: string[] | undefined; audioSources?: string[] | undefined; attachments?: ChatAttachment[] | undefined;
}

/** Recompute visible media before recovery, safety, caption, vision and audio preparation. */
export function foldMessageForModel<T extends ModelMediaMessage>(message: T): T {
  const original = [...walkMessageContentParts(message.contentParts)];
  if (!original.some(part => part.kind === "embedded_message" && part.relation === "forward")) return message;
  const contentParts = foldForwardRecords(message.contentParts ?? []);
  const visible = [...walkMessageContentParts(contentParts)];
  const fileIds = (parts: typeof original) => new Set(parts.flatMap(part =>
    (part.kind === "image" || part.kind === "emoji" || part.kind === "asset_file") && part.fileId ? [part.fileId] : []));
  const allFiles = fileIds(original), visibleFiles = fileIds(visible);
  const hiddenFiles = new Set([...allFiles].filter(id => !visibleFiles.has(id)));
  const allAudioIds = new Set(original.flatMap(part => part.kind === "audio" && part.audioId ? [part.audioId] : []));
  const visibleAudioIds = new Set(visible.flatMap(part => part.kind === "audio" && part.audioId ? [part.audioId] : []));
  const hiddenAudioIds = new Set([...allAudioIds].filter(id => !visibleAudioIds.has(id)));
  const visibleSources = new Set(visible.flatMap(part => (part.kind === "image" || part.kind === "emoji" || part.kind === "audio") && part.source ? [part.source] : []));
  const hiddenSources = new Set(original.flatMap(part => (part.kind === "image" || part.kind === "emoji" || part.kind === "audio") && part.source && !visibleSources.has(part.source) ? [part.source] : []));
  return { ...message, contentParts,
    images: (message.images ?? []).filter(source => !hiddenSources.has(source)),
    emojiSources: (message.emojiSources ?? []).filter(source => !hiddenSources.has(source)),
    imageIds: (message.imageIds ?? []).filter(id => !hiddenFiles.has(id)),
    emojiIds: (message.emojiIds ?? []).filter(id => !hiddenFiles.has(id)),
    attachments: message.attachments?.filter(file => !hiddenFiles.has(file.fileId)),
    audioIds: (message.audioIds ?? []).filter(id => !hiddenAudioIds.has(id)),
    audioSources: (message.audioSources ?? []).filter((source, index) => !hiddenSources.has(source) && !hiddenAudioIds.has(message.audioIds?.[index] ?? ""))
  };
}
