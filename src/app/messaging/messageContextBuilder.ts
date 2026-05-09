import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { MessageContentPart, MessageMediaContentPart } from "#messages/contentParts.ts";
import {
  dedupeResolvedChatAttachments,
  isPendingChatAttachmentId
} from "#services/workspace/chatAttachments.ts";
import type { MessageHandlerServices, MessageProcessingContext } from "./messageHandlerTypes.ts";

export async function createMessageProcessingContext(
  services: Pick<
    MessageHandlerServices,
    "audioStore" | "chatFileStore" | "sessionManager" | "userStore" | "setupStore" | "userIdentityStore"
  >,
  incomingMessage: ParsedIncomingMessage,
  options?: {
    targetSessionId?: string;
    delivery?: "onebot" | "web";
  }
): Promise<MessageProcessingContext> {
  const channelId = incomingMessage.channelId ?? "qqbot";
  const externalUserId = incomingMessage.externalUserId ?? incomingMessage.userId;
  const incomingMediaParts = collectIncomingMediaParts(incomingMessage);
  const resolvedUserId = options?.delivery === "web"
    ? incomingMessage.userId
    : (await services.userIdentityStore.ensureUserIdentity({
        channelId,
        externalId: externalUserId
      })).internalUserId;
  const [setupState, user, registeredAudios, importedImageAssets] = await Promise.all([
    services.setupStore.get(),
    services.userStore.touchSeenUser({
      userId: resolvedUserId
    }),
    services.audioStore.registerSources(incomingMessage.audioSources),
    Promise.all(
      incomingMediaParts
        .map(async (part) => services.chatFileStore.importRemoteSource({
          source: part.source,
          kind: "image",
          origin: "chat_message",
          sourceContext: {
            mediaKind: part.kind,
            userId: resolvedUserId,
            senderName: incomingMessage.senderName
          }
        })
          .then((asset) => ({ part, asset }))
          .catch(() => ({ part, asset: null })))
    )
  ]);

  const preservedImageIds = (incomingMessage.imageIds ?? []).filter((fileId) => !isPendingChatAttachmentId(fileId));
  const preservedEmojiIds = (incomingMessage.emojiIds ?? []).filter((fileId) => !isPendingChatAttachmentId(fileId));
  const preservedAttachments = dedupeResolvedChatAttachments(incomingMessage.attachments ?? []);
  const importedImageRecords = importedImageAssets.filter((item): item is { part: MessageMediaContentPart & { source: string }; asset: NonNullable<typeof item.asset> } => item.asset != null);
  const contentParts = resolveImportedContentParts(
    incomingMessage.contentParts ?? [],
    importedImageRecords,
    registeredAudios
  );

  const enrichedMessage = {
    ...incomingMessage,
    channelId,
    externalUserId,
    userId: resolvedUserId,
    audioIds: registeredAudios.map((item: { id: string }) => item.id),
    imageIds: Array.from(new Set([
      ...preservedImageIds,
      ...importedImageRecords
      .filter((item) => item.asset.sourceContext.mediaKind !== "emoji")
      .map((item) => item.asset.fileId),
    ])),
    emojiIds: Array.from(new Set([
      ...preservedEmojiIds,
      ...importedImageRecords
      .filter((item) => item.asset.sourceContext.mediaKind === "emoji")
      .map((item) => item.asset.fileId),
    ])),
    attachments: dedupeResolvedChatAttachments([
      ...preservedAttachments,
      ...importedImageRecords
        .map(({ asset }) => ({
          fileId: asset.fileId,
          kind: asset.kind,
          source: "chat_message" as const,
          sourceName: asset.sourceName,
          mimeType: asset.mimeType,
          semanticKind: asset.sourceContext.mediaKind === "emoji" ? "emoji" as const : "image" as const
        })),
    ]),
    ...(contentParts.length > 0 ? { contentParts } : {})
  };

  return {
    setupState,
    user,
    enrichedMessage,
    session: options?.targetSessionId
      ? resolveTargetSession(services.sessionManager, enrichedMessage, options.targetSessionId)
      : services.sessionManager.getOrCreateSession(enrichedMessage)
  };
}

function collectIncomingMediaParts(
  incomingMessage: ParsedIncomingMessage
): Array<MessageMediaContentPart & { source: string }> {
  const orderedParts = (incomingMessage.contentParts ?? []).filter((part): part is MessageMediaContentPart & { source: string } => (
    (part.kind === "image" || part.kind === "emoji")
    && typeof part.source === "string"
    && part.source.trim().length > 0
  ));
  if (orderedParts.length > 0) {
    return orderedParts;
  }
  return incomingMessage.images.map((source) => ({
    kind: incomingMessage.emojiSources.includes(source) ? "emoji" : "image",
    source
  }));
}

function resolveImportedContentParts(
  contentParts: readonly MessageContentPart[],
  imported: Array<{
    part: MessageMediaContentPart & { source: string };
    asset: {
      fileId: string;
      sourceName: string | null;
      mimeType: string | null;
    };
  }>,
  registeredAudios: Array<{ id: string; source: string }>
): MessageContentPart[] {
  const remaining = [...imported];
  const audioIdBySource = new Map(registeredAudios.map((item) => [item.source, item.id]));
  return contentParts.map((part) => {
    if (part.kind === "image" || part.kind === "emoji") {
      const index = remaining.findIndex((item) => item.part === part);
      if (index < 0) {
        return part;
      }
      const [matched] = remaining.splice(index, 1);
      if (!matched) {
        return part;
      }
      return {
        kind: part.kind,
        fileId: matched.asset.fileId,
        sourceName: matched.asset.sourceName,
        mimeType: matched.asset.mimeType
      };
    }
    if (part.kind === "audio" && part.source) {
      const audioId = audioIdBySource.get(part.source);
      return audioId
        ? { ...part, audioId }
        : part;
    }
    return part;
  });
}

function resolveTargetSession(
  sessionManager: Pick<MessageHandlerServices, "sessionManager">["sessionManager"],
  incomingMessage: ParsedIncomingMessage,
  targetSessionId: string
) {
  const session = sessionManager.getSession(targetSessionId);
  if (session.type !== incomingMessage.chatType) {
    throw new Error(`Session type mismatch for ${targetSessionId}`);
  }
  return session;
}
