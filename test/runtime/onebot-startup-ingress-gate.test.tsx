import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createOneBotStartupIngressGate } from "../../src/app/runtime/oneBotStartupIngressGate.ts";
import type { OneBotMessageEvent, OneBotRequestEvent } from "../../src/services/onebot/types.ts";

test("OneBot startup ingress gate buffers and replays startup events before live events", async () => {
  const handled: string[] = [];
  let releaseFirstMessage!: () => void;
  const firstMessageStarted = new Promise<void>((resolve) => {
    releaseFirstMessage = resolve;
  });
  const gate = createOneBotStartupIngressGate({
    logger: pino({ level: "silent" }),
    async handleMessageEvent(event) {
      handled.push(`message:${event.message_id}`);
      if (event.message_id === 1) {
        await firstMessageStarted;
      }
    },
    async handleRequestEvent(event) {
      handled.push(`request:${event.flag}`);
    }
  });

  await gate.handleMessageEvent(createMessageEvent(1));
  await gate.handleRequestEvent(createRequestEvent("friend-1"));

  const opened = gate.open();
  const live = gate.handleMessageEvent(createMessageEvent(2));
  assert.deepEqual(handled, ["message:1"]);

  releaseFirstMessage();
  await opened;
  await live;

  assert.deepEqual(handled, ["message:1", "request:friend-1", "message:2"]);
});

function createMessageEvent(messageId: number): OneBotMessageEvent {
  return {
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: messageId,
    user_id: 123,
    message: [{ type: "text", data: { text: `m${messageId}` } }],
    raw_message: `m${messageId}`,
    sender: { user_id: 123, nickname: "Alice" },
    self_id: 999,
    time: 1710000000 + messageId
  };
}

function createRequestEvent(flag: string): OneBotRequestEvent {
  return {
    post_type: "request",
    request_type: "friend",
    self_id: 999,
    time: 1710000000,
    user_id: 123,
    flag
  };
}
