import type { Logger } from "pino";
import type { OneBotMessageEvent, OneBotRequestEvent } from "#services/onebot/types.ts";

export interface OneBotStartupIngressGate {
  handleMessageEvent(event: OneBotMessageEvent): Promise<void>;
  handleRequestEvent(event: OneBotRequestEvent): Promise<void>;
  open(): Promise<void>;
}

export function createOneBotStartupIngressGate(input: {
  logger: Logger;
  handleMessageEvent: (event: OneBotMessageEvent) => Promise<void>;
  handleRequestEvent: (event: OneBotRequestEvent) => Promise<void>;
}): OneBotStartupIngressGate {
  const queuedEvents: Array<
    | { kind: "message"; event: OneBotMessageEvent }
    | { kind: "request"; event: OneBotRequestEvent }
  > = [];
  let opened = false;
  let replayPromise: Promise<void> = Promise.resolve();

  return {
    async handleMessageEvent(event) {
      if (!opened) {
        queuedEvents.push({ kind: "message", event });
        return;
      }
      await replayPromise;
      await input.handleMessageEvent(event);
    },
    async handleRequestEvent(event) {
      if (!opened) {
        queuedEvents.push({ kind: "request", event });
        return;
      }
      await replayPromise;
      await input.handleRequestEvent(event);
    },
    async open() {
      replayPromise = replayQueuedEvents({
        logger: input.logger,
        queuedEvents,
        handleMessageEvent: input.handleMessageEvent,
        handleRequestEvent: input.handleRequestEvent
      });
      opened = true;
      await replayPromise;
    }
  };
}

async function replayQueuedEvents(input: {
  logger: Logger;
  queuedEvents: Array<
    | { kind: "message"; event: OneBotMessageEvent }
    | { kind: "request"; event: OneBotRequestEvent }
  >;
  handleMessageEvent: (event: OneBotMessageEvent) => Promise<void>;
  handleRequestEvent: (event: OneBotRequestEvent) => Promise<void>;
}): Promise<void> {
  for (let index = 0; index < input.queuedEvents.length; index += 1) {
    const queued = input.queuedEvents[index];
    try {
      if (queued?.kind === "message") {
        await input.handleMessageEvent(queued.event);
      } else if (queued?.kind === "request") {
        await input.handleRequestEvent(queued.event);
      }
    } catch (error: unknown) {
      input.logger.error({ error, eventKind: queued?.kind }, "onebot_startup_buffered_event_failed");
    }
  }
  input.queuedEvents.length = 0;
}
