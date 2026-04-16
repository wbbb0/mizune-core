import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { OneBotApiResponse } from "./types.ts";

export interface OneBotTypingInput {
  enabled: boolean;
  chatType: "private" | "group";
  userId: string;
  groupId?: string;
}

export interface OneBotTypingAdapter {
  setTyping(input: OneBotTypingInput): Promise<boolean>;
}

type OneBotApiCaller = <T extends OneBotApiResponse>(endpoint: string, body: Record<string, unknown>) => Promise<T>;

const NAPCAT_TYPING_EVENT_TYPE = {
  start: 1,
  stop: 2
} as const;

export function createOneBotTypingAdapter(
  config: AppConfig,
  logger: Logger,
  postApi: OneBotApiCaller
): OneBotTypingAdapter {
  if (config.onebot.provider !== "napcat") {
    return {
      async setTyping() {
        return false;
      }
    };
  }

  return new NapCatTypingAdapter(config, logger, postApi);
}

class NapCatTypingAdapter implements OneBotTypingAdapter {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly postApi: OneBotApiCaller
  ) {}

  async setTyping(input: OneBotTypingInput): Promise<boolean> {
    if (!this.isChatEnabled(input.chatType)) {
      return false;
    }

    if (input.chatType === "group" && !input.groupId) {
      this.logger.warn(
        {
          provider: this.config.onebot.provider,
          chatType: input.chatType,
          userId: input.userId,
          enabled: input.enabled
        },
        "onebot_typing_skipped_missing_group_id"
      );
      return false;
    }

    const body = {
      user_id: Number(input.userId),
      event_type: input.enabled ? NAPCAT_TYPING_EVENT_TYPE.start : NAPCAT_TYPING_EVENT_TYPE.stop,
      ...(input.chatType === "group" && input.groupId
        ? { group_id: Number(input.groupId) }
        : {})
    };

    try {
      const payload = await this.postApi<OneBotApiResponse>("set_input_status", body);
      if (payload.retcode !== 0) {
        throw new Error(
          `OneBot API returned error: ${payload.retcode} ${payload.message ?? payload.wording ?? ""}`.trim()
        );
      }
      return true;
    } catch (error) {
      const details = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };
      this.logger.warn(
        {
          provider: this.config.onebot.provider,
          chatType: input.chatType,
          userId: input.userId,
          groupId: input.groupId,
          enabled: input.enabled,
          error: details
        },
        "onebot_typing_failed"
      );
      return false;
    }
  }

  private isChatEnabled(chatType: OneBotTypingInput["chatType"]): boolean {
    if (!this.config.onebot.typing.enabled) {
      return false;
    }

    return chatType === "group"
      ? this.config.onebot.typing.group
      : this.config.onebot.typing.private;
  }
}
