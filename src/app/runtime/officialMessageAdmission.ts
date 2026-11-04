import type { ParsedIncomingMessage } from "#services/messaging/incomingMessage.ts";
import type { UserIdentityStore } from "#identity/userIdentityStore.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";

/** Admission happens before any media import, session creation or model invocation. */
export function isOfficialMessageAllowed(
  message: ParsedIncomingMessage,
  whitelistEnabled: boolean,
  whitelist: Pick<WhitelistStore, "hasGroup" | "hasUser">,
  identities: Pick<UserIdentityStore, "findInternalUserIdSync">
): boolean {
  if (message.source !== "qq_official" || !message.replyContext || !message.channelId) return false;
  if (message.chatType === "group" && (!message.isAtMentioned || !message.groupId)) return false;
  if (!whitelistEnabled) return true;
  const externalId = message.externalUserId ?? message.userId;
  const internalId = identities.findInternalUserIdSync({
    channelId: message.chatType === "group" ? `${message.channelId}.group.${message.groupId}` : message.channelId,
    scope: message.chatType === "group" ? "group_member" : "private_user",
    externalId
  });
  return internalId === "owner" || whitelist.hasUser(externalId)
    || (internalId != null && whitelist.hasUser(internalId))
    || (message.groupId != null && whitelist.hasGroup(message.groupId));
}
