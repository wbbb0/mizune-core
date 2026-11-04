import type { LlmMessage } from "#llm/provider/providerTypes.ts";
import type { MediaImportService } from "#services/workspace/mediaSources/service.ts";
import type { MediaResolution } from "#services/workspace/mediaSources/types.ts";
import { mediaScopeForSession, mediaResolutionPart, resolvePendingMediaParts } from "#services/workspace/mediaSources/content.ts";
import { formatHistoryContent } from "#conversation/session/historyContext.ts";
import { dedupeResolvedChatAttachments } from "#services/workspace/chatAttachments.ts";
import { parseProtocolLine } from "#utils/structuredEnvelope.ts";
import { walkMessageContentParts, collectContentPartAttachments, collectContentPartMediaIds } from "#messages/contentParts.ts";
import type { GenerationPromptBatchMessage, GenerationPromptHistoryMessage } from "./generationPromptBuilder.ts";

/** Only the actual prompt window and current batch can trigger recovery, never the entire stored transcript. */
export async function recoverPromptMedia<T extends {
  sessionId: string; historyForPrompt: GenerationPromptHistoryMessage[]; batchMessages?: GenerationPromptBatchMessage[];
  replayMessages?: LlmMessage[]; abortSignal?: AbortSignal;
  contentSafetyAlreadyProjected?: boolean | undefined;
}>(service: MediaImportService, input: T): Promise<T> {
  const refs = new Set<string>();
  const collect = (content: string) => {
    for (const line of content.split("\n")) {
      const tag = parseProtocolLine(line);
      if (tag && ["pending_media", "ref", "asset_file"].includes(tag.tag) && /^media_[a-f0-9]{32}$/.test(tag.attrs.media_ref ?? "")) refs.add(tag.attrs.media_ref!);
    }
  };
  input.historyForPrompt.forEach(message => collect(message.content));
  input.replayMessages?.forEach(message => { if (typeof message.content === "string") collect(message.content); });
  for (const message of input.batchMessages ?? []) {
    for (const part of walkMessageContentParts(message.contentParts)) if ((part.kind === "pending_media" || part.kind === "image" || part.kind === "emoji" || part.kind === "asset_file") && part.mediaRef) refs.add(part.mediaRef);
  }
  if (!refs.size) return input;
  const resolutions = new Map<string, MediaResolution>();
  const scope = mediaScopeForSession(input.sessionId);
  await Promise.all([...refs].slice(0, 16).map(async ref => {
    const result = await service.resolve(scope, ref, input.abortSignal);
    if (result) resolutions.set(ref, result);
  }));
  let mediaChanged = false;
  const replace = (content: string) => content.split("\n").map(line => {
    const tag = parseProtocolLine(line);
    const resolution = tag && ["pending_media", "ref", "asset_file"].includes(tag.tag) ? resolutions.get(tag.attrs.media_ref ?? "") : undefined;
    if (resolution && (tag?.tag === "pending_media" || (tag?.tag === "ref" ? tag.attrs.image_id : tag?.attrs.file_id) !== resolution.file.fileId)) mediaChanged = true;
    return resolution ? formatHistoryContent({ text: "", contentParts: [mediaResolutionPart(resolution)] }) : line;
  }).join("\n");
  const historyForPrompt = input.historyForPrompt.map(message => ({ ...message, content: replace(message.content) }));
  const replayMessages = input.replayMessages?.map(message => typeof message.content === "string" ? { ...message, content: replace(message.content) } : message);
  for (const message of input.batchMessages ?? []) for (const part of walkMessageContentParts(message.contentParts)) {
    if ((part.kind === "pending_media" || part.kind === "image" || part.kind === "emoji" || part.kind === "asset_file") && part.mediaRef) {
      const resolved = resolutions.get(part.mediaRef);
      if (resolved && (part.kind === "pending_media" || part.fileId !== resolved.file.fileId)) mediaChanged = true;
    }
  }
  return { ...input,
    ...(mediaChanged ? { contentSafetyAlreadyProjected: false } : {}),
    historyForPrompt,
    ...(replayMessages ? { replayMessages } : {}),
    ...(input.batchMessages ? { batchMessages: input.batchMessages.map(message => {
      const replacedIds = new Set([...walkMessageContentParts(message.contentParts)].flatMap(part => {
        if ((part.kind !== "image" && part.kind !== "emoji" && part.kind !== "asset_file") || !part.mediaRef || !part.fileId) return [];
        const resolution = resolutions.get(part.mediaRef);
        return resolution && resolution.file.fileId !== part.fileId ? [part.fileId] : [];
      }));
      const parts = resolvePendingMediaParts(message.contentParts ?? [], resolutions);
      return { ...message, contentParts: parts,
        imageIds: [...new Set([...message.imageIds.filter(id => !replacedIds.has(id)), ...collectContentPartMediaIds(parts, "image")])],
        emojiIds: [...new Set([...message.emojiIds.filter(id => !replacedIds.has(id)), ...collectContentPartMediaIds(parts, "emoji")])],
        attachments: dedupeResolvedChatAttachments([...(message.attachments ?? []).filter(file => !replacedIds.has(file.fileId)), ...collectContentPartAttachments(parts)]) };
    }) } : {})
  };
}
