import type { ParsedIncomingMessage } from "#services/onebot/types.ts";
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
      incomingMessage.images
        .map(async (source) => services.chatFileStore.importRemoteSource({
          source,
          kind: "image",
          origin: "chat_message",
          sourceContext: {
            mediaKind: incomingMessage.emojiSources.includes(source) ? "emoji" : "image",
            userId: resolvedUserId,
            senderName: incomingMessage.senderName
          }
        }).catch(() => null))
    )
  ]);

  const preservedImageIds = (incomingMessage.imageIds ?? []).filter((fileId) => !isPendingChatAttachmentId(fileId));
  const preservedEmojiIds = (incomingMessage.emojiIds ?? []).filter((fileId) => !isPendingChatAttachmentId(fileId));
  const preservedAttachments = dedupeResolvedChatAttachments(incomingMessage.attachments ?? []);
  const importedImageRecords = importedImageAssets.filter((item): item is NonNullable<typeof item> => item != null);

  const enrichedMessage = {
    ...incomingMessage,
    channelId,
    externalUserId,
    userId: resolvedUserId,
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
    attachments: dedupeResolvedChatAttachments([
      ...preservedAttachments,
      ...importedImageRecords
        .map((item) => ({
          fileId: item.fileId,
          kind: item.kind,
          source: "chat_message" as const,
          sourceName: item.sourceName,
          mimeType: item.mimeType,
          semanticKind: item.sourceContext.mediaKind === "emoji" ? "emoji" as const : "image" as const
        })),
    ])
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
