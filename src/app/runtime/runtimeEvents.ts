import type { Logger } from "pino";
import type { RequestStore } from "#requests/requestStore.ts";
import type { OneBotMessageEvent, OneBotRequestEvent } from "#services/onebot/types.ts";

export function createMessageListener(
  logger: Logger,
  handleMessageEvent: (event: OneBotMessageEvent) => Promise<void>
) {
  return (event: OneBotMessageEvent) => {
    void handleMessageEvent(event).catch((error: unknown) => {
      logger.error({ error }, "message_user_upsert_failed");
    });
  };
}

export function createRequestListener(
  logger: Logger,
  requestStore: Pick<RequestStore, "upsertFromEvent">
) {
  return (event: OneBotRequestEvent) => {
    void requestStore.upsertFromEvent(event).catch((error: unknown) => {
      logger.error({ error, requestType: event.request_type, flag: event.flag }, "request_cache_failed");
    });
  };
}
