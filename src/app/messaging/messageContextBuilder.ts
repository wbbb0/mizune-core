import { extractFileSources } from "#services/onebot/messageSegments.ts";
import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
import type { MessageHandlerServices, MessageProcessingContext } from "./messageHandlerTypes.ts";

export async function createMessageProcessingContext(
  services: Pick<
    MessageHandlerServices,
    "audioStore" | "mediaWorkspace" | "sessionManager" | "userStore" | "setupStore"
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
      userId: incomingMessage.userId,
      nickname: incomingMessage.senderName
    }),
    services.audioStore.registerSources(incomingMessage.audioSources),
    Promise.all(
      incomingMessage.images
        .map(async (source) => services.mediaWorkspace.importRemoteSource({
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
      fileSources.map(async (fileSource) => services.mediaWorkspace.importRemoteSource({
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

  const enrichedMessage = {
    ...incomingMessage,
    audioIds: registeredAudios.map((item: { id: string }) => item.id),
    imageIds: importedImageAssets
      .filter((item): item is NonNullable<typeof item> => item != null)
      .filter((item) => item.sourceContext.mediaKind !== "emoji")
      .map((item) => item.fileId),
    emojiIds: importedImageAssets
      .filter((item): item is NonNullable<typeof item> => item != null)
      .filter((item) => item.sourceContext.mediaKind === "emoji")
      .map((item) => item.fileId),
    attachments: [
      ...importedImageAssets
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .map((item) => ({
          fileId: item.fileId,
          kind: item.kind,
          source: "chat_message" as const,
          sourceName: item.sourceName,
          mimeType: item.mimeType,
          semanticKind: item.sourceContext.mediaKind === "emoji" ? "emoji" : "image"
        })),
      ...importedFileAssets
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .map((item) => ({
          fileId: item.fileId,
          kind: item.kind,
          source: "chat_message" as const,
          sourceName: item.sourceName,
          mimeType: item.mimeType
        }))
    ]
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
