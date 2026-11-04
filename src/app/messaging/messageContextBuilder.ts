import { walkMessageContentParts } from "#messages/contentParts.ts";
import { resolveLocalReferences } from "#services/messaging/localReferences.ts";
import { buildSessionId } from "#conversation/session/sessionIdentity.ts";
import type { ParsedIncomingMessage } from "#services/messaging/incomingMessage.ts";
import { importIncomingContent } from "#services/messaging/importIncomingContent.ts";
import type { MessageHandlerServices, MessageProcessingContext } from "./messageHandlerTypes.ts";

export async function createMessageProcessingContext(
  services: Pick<
    MessageHandlerServices,
    "audioStore" | "chatFileStore" | "mediaImportService" | "oneBotReferenceResolver" | "sessionManager" | "userStore" | "setupStore" | "userIdentityStore"
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
  let messageWithReferences = incomingMessage;
  if (incomingMessage.contentParts?.some(part => part.kind === "reply" || part.kind === "embedded_message")) {
    let items: import("#conversation/session/sessionTypes.ts").InternalTranscriptItem[] = [];
    try { items = services.sessionManager.getSession(options?.targetSessionId ?? buildSessionId(incomingMessage)).internalTranscript; }
    catch (error) { if (!(error instanceof Error && error.message.startsWith("Session not found:"))) throw error; }
    if (items.length) messageWithReferences = { ...incomingMessage, contentParts: resolveLocalReferences(incomingMessage.contentParts, items) };
  }
  const messageForImport = messageWithReferences.source !== "qq_official" && options?.delivery !== "web" && [...walkMessageContentParts(messageWithReferences.contentParts)].some(part => part.kind === "reply" || part.kind === "forward")
    ? { ...messageWithReferences, contentParts: await services.oneBotReferenceResolver.expand(
        { sessionId: options?.targetSessionId ?? buildSessionId(incomingMessage), connectionId: channelId }, messageWithReferences.contentParts!) }
    : messageWithReferences;
  const [setupState, user, imported] = await Promise.all([
    services.setupStore.get(), services.userStore.touchSeenUser({ userId: resolvedUserId }),
    importIncomingContent(services, messageForImport, resolvedUserId)
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
