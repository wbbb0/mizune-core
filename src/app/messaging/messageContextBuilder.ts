import { extractFileSources } from "#services/onebot/messageSegments.ts";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { MessageHandlerServices, MessageProcessingContext } from "./messageHandlerTypes.ts";

export async function createMessageProcessingContext(
  services: Pick<
    MessageHandlerServices,
    "audioStore" | "chatFileStore" | "sessionManager" | "userStore" | "setupStore"
  >,
  incomingMessage: ParsedIncomingMessage,
  options?: {
    targetSessionId?: string;
  }
): Promise<MessageProcessingContext> {
  const fileSources = incomingMessage.rawEvent
    ? extractFileSources(incomingMessage.rawEvent.message)
    : [];
  const [setupState, user, registeredAudios, importedImageAssets, importedFileAssets] = await Promise.all([
    services.setupStore.get(),
    services.userStore.touchSeenUser({
      userId: incomingMessage.userId
    }),
    services.audioStore.registerSources(incomingMessage.audioSources),
    Promise.all(
      incomingMessage.images
        .map(async (source) => services.chatFileStore.importRemoteSource({
          source,
          kind: "image",
          origin: "chat_message",
          sourceContext: {
            mediaKind: incomingMessage.emojiSources.includes(source) ? "emoji" : "image",
            userId: incomingMessage.userId,
            senderName: incomingMessage.senderName
          }
        }).catch(() => null))
    ),
    Promise.all(
      fileSources.map(async (fileSource) => services.chatFileStore.importRemoteSource({
        source: fileSource.source,
        kind: "file",
        origin: "chat_message",
        ...(fileSource.filename ? { sourceName: fileSource.filename } : {}),
        ...(fileSource.mimeType ? { mimeType: fileSource.mimeType } : {}),
        sourceContext: {
          userId: incomingMessage.userId,
          senderName: incomingMessage.senderName
        }
      }).catch(() => null))
    )
  ]);

  const preservedImageIds = incomingMessage.imageIds ?? [];
  const preservedEmojiIds = incomingMessage.emojiIds ?? [];
  const preservedAttachments = incomingMessage.attachments ?? [];
  const importedImageRecords = importedImageAssets.filter((item): item is NonNullable<typeof item> => item != null);
  const importedFileRecords = importedFileAssets.filter((item): item is NonNullable<typeof item> => item != null);

  const enrichedMessage = {
    ...incomingMessage,
    audioIds: registeredAudios.map((item: { id: string }) => item.id),
    imageIds: Array.from(new Set([
      ...preservedImageIds,
      ...importedImageRecords
      .filter((item) => item.sourceContext.mediaKind !== "emoji")
      .map((item) => item.fileId),
    ])),
    emojiIds: Array.from(new Set([
      ...preservedEmojiIds,
      ...importedImageRecords
      .filter((item) => item.sourceContext.mediaKind === "emoji")
      .map((item) => item.fileId),
    ])),
    attachments: dedupeAttachmentsByFileId([
      ...preservedAttachments,
      ...importedImageRecords
        .map((item) => ({
          fileId: item.fileId,
          kind: item.kind,
          source: "chat_message" as const,
          sourceName: item.sourceName,
          mimeType: item.mimeType,
          semanticKind: item.sourceContext.mediaKind === "emoji" ? "emoji" : "image"
        })),
      ...importedFileRecords
        .map((item) => ({
          fileId: item.fileId,
          kind: item.kind,
          source: "chat_message" as const,
          sourceName: item.sourceName,
          mimeType: item.mimeType
        }))
    ])
  };

  return {
    setupState,
    user,
    enrichedMessage,
    session: options?.targetSessionId
      ? resolveTargetSession(services.sessionManager, incomingMessage, options.targetSessionId)
      : services.sessionManager.getOrCreateSession(enrichedMessage)
  };
}

function dedupeAttachmentsByFileId<T extends { fileId: string }>(attachments: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const attachment of attachments) {
    if (seen.has(attachment.fileId)) {
      continue;
    }
    seen.add(attachment.fileId);
    deduped.push(attachment);
  }
  return deduped;
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
