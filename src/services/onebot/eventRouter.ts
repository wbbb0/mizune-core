import type { AppConfig } from "#config/config.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";
import { extractEventMessageText, parseIncomingMessage } from "./messageParsing.ts";
import type { ParsedIncomingMessage, OneBotMessageEvent, OneBotMessageSegment } from "./types.ts";

export class EventRouter {
  constructor(
    private readonly config: AppConfig,
    private readonly whitelistStore: Pick<WhitelistStore, "hasUser" | "getOwnerId"> = {
      hasUser: () => false,
      getOwnerId: () => undefined
    },
    private readonly isImplicitlyAllowedUser: (userId: string) => boolean = () => false,
    private readonly isOwnerBootstrapText: (text: string) => boolean = () => false
  ) {}

  isAllowed(event: OneBotMessageEvent): boolean {
    if (event.message_type === "private") {
      if (!this.config.whitelist.enabled) {
        return true;
      }

      if (!this.whitelistStore.getOwnerId() && this.isOwnerBootstrapText(extractEventMessageText(event))) {
        return true;
      }

      const userId = String(event.user_id);
      const userMatched = this.whitelistStore.hasUser(userId)
        || this.whitelistStore.getOwnerId() === userId
        || this.isImplicitlyAllowedUser(userId);
      return userMatched;
    }

    return true;
  }

  toIncomingMessage(event: OneBotMessageEvent): ParsedIncomingMessage | null {
    if (event.user_id === event.self_id) {
      return null;
    }

    if (!this.isAllowed(event)) {
      return null;
    }

    return parseIncomingMessage(event);
  }
}
