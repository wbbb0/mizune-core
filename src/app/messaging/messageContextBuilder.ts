import type { ParsedIncomingMessage } from "#services/messaging/incomingMessage.ts";
import { importIncomingContent } from "./incomingContentImport.ts";
import type { MessageHandlerServices, MessageProcessingContext } from "./messageHandlerTypes.ts";

export async function createMessageProcessingContext(
  services: Pick<
    MessageHandlerServices,
    "audioStore" | "chatFileStore" | "sessionManager" | "userStore" | "setupStore" | "userIdentityStore"
  >,
  incomingMessage: ParsedIncomingMessage,
  options?: {
    targetSessionId?: string;
    delivery?: "onebot" | "qq_official" | "web";
  }
): Promise<MessageProcessingContext> {
  const channelId = incomingMessage.channelId ?? "qqbot";
  const externalUserId = incomingMessage.externalUserId ?? incomingMessage.userId;
  const resolvedUserId = options?.delivery === "web"
    ? incomingMessage.userId
    : (await services.userIdentityStore.ensureUserIdentity({
        channelId: incomingMessage.source === "qq_official" && incomingMessage.chatType === "group"
          ? `${channelId}.group.${incomingMessage.groupId}` : channelId,
        scope: incomingMessage.source === "qq_official" && incomingMessage.chatType === "group" ? "group_member" : "private_user",
        externalId: externalUserId
      })).internalUserId;
  const [setupState, user, imported] = await Promise.all([
    services.setupStore.get(), services.userStore.touchSeenUser({ userId: resolvedUserId }),
    importIncomingContent(services, incomingMessage, resolvedUserId)
  ]);
  const { remoteAttachments: _remote, ...messageWithoutRemoteAttachments } = incomingMessage;
  const enrichedMessage = {
    ...messageWithoutRemoteAttachments, channelId, externalUserId, userId: resolvedUserId,
    ...imported
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
