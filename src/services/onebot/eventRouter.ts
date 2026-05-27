import type { AppConfig } from "#config/config.ts";
import type { UserIdentityStore } from "#identity/userIdentityStore.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";
import { extractEventMessageText, parseIncomingMessage } from "./messageParsing.ts";
import type { ParsedIncomingMessage, OneBotMessageEvent, OneBotMessageSegment } from "./types.ts";

export class EventRouter {
  constructor(
    private readonly config: AppConfig,
    private readonly channelId: string,
    private readonly whitelistStore: Pick<WhitelistStore, "hasUser" | "hasGroup"> = {
      hasUser: () => false,
      hasGroup: () => false
    },
    private readonly userIdentityStore: Pick<UserIdentityStore, "hasOwnerIdentitySync" | "findInternalUserIdSync"> = {
      hasOwnerIdentitySync: () => false,
      findInternalUserIdSync: () => undefined
    },
    private readonly isImplicitlyAllowedUser: (userId: string) => boolean = () => false,
    private readonly isOwnerBootstrapText: (text: string) => boolean = () => false
  ) {}

  isAllowed(event: OneBotMessageEvent): boolean {
    if (event.message_type === "private") {
      if (!this.config.whitelist.enabled) {
        return true;
      }

      if (!this.userIdentityStore.hasOwnerIdentitySync() && this.isOwnerBootstrapText(extractEventMessageText(event))) {
        return true;
      }

      const userId = String(event.user_id);
      const userMatched = this.isWhitelistedUser(userId)
        || this.isOwnerUser(userId)
        || this.isImplicitlyAllowedUser(userId);
      return userMatched;
    }

    if (event.message_type === "group") {
      if (!this.config.whitelist.enabled) {
        return true;
      }
      const groupId = String(event.group_id ?? "").trim();
      if (!groupId) {
        return false;
      }
      const userId = String(event.user_id);
      return this.whitelistStore.hasGroup(groupId) || this.isWhitelistedUser(userId) || this.isOwnerUser(userId);
    }

    return false;
  }

  toIncomingMessage(event: OneBotMessageEvent): ParsedIncomingMessage | null {
    if (event.user_id === event.self_id) {
      return null;
    }

    if (!this.isAllowed(event)) {
      return null;
    }

    return parseIncomingMessage(event, { channelId: this.channelId });
  }

  private isOwnerUser(userId: string): boolean {
    return this.userIdentityStore.findInternalUserIdSync({ channelId: this.channelId, externalId: userId }) === "owner";
  }

  private isWhitelistedUser(externalUserId: string): boolean {
    if (this.whitelistStore.hasUser(externalUserId)) {
      return true;
    }
    const internalUserId = this.userIdentityStore.findInternalUserIdSync({
      channelId: this.channelId,
      externalId: externalUserId
    });
    return Boolean(internalUserId && this.whitelistStore.hasUser(internalUserId));
  }
}
