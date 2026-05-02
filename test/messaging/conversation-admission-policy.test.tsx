import test from "node:test";
import assert from "node:assert/strict";
import { resolveAdmissionDecision } from "../../src/app/messaging/conversationAdmissionPolicy.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import type { ParsedIncomingMessage } from "../../src/services/onebot/types.ts";

function createMessage(overrides: Partial<ParsedIncomingMessage> = {}): ParsedIncomingMessage {
  const message: ParsedIncomingMessage = {
    chatType: "group",
    userId: "u1",
    groupId: "g1",
    senderName: "Alice",
    text: "普通消息",
    images: [],
    audioSources: [],
    audioIds: [],
    emojiSources: [],
    imageIds: [],
    emojiIds: [],
    attachments: [],
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    isAtMentioned: false,
    ...overrides
  };
  if (message.chatType === "private") {
    delete message.groupId;
  }
  return message;
}

test("admission policy always replies in private chats", () => {
  const config = createTestAppConfig({ whitelist: { enabled: false } });

  const decision = resolveAdmissionDecision({
    config,
    message: createMessage({ chatType: "private" }),
    relationship: "known",
    groupMatched: false,
    matchedPendingGroupTrigger: false,
    replyToBot: false,
    hasActiveResponse: true
  });

  assert.equal(decision.threadAction, "reply_now");
  assert.equal(decision.replyDecision, "reply_small");
  assert.equal(decision.interruptPolicy, "soft_interrupt");
  assert.equal(decision.shouldTriggerResponse, true);
});

test("admission policy stores ordinary group messages as ambient without triggering", () => {
  const config = createTestAppConfig({ whitelist: { enabled: false } });

  const decision = resolveAdmissionDecision({
    config,
    message: createMessage(),
    relationship: "known",
    groupMatched: true,
    matchedPendingGroupTrigger: false,
    replyToBot: false,
    hasActiveResponse: false
  });

  assert.equal(decision.threadAction, "ambient_only");
  assert.equal(decision.replyDecision, "no_reply");
  assert.equal(decision.shouldTriggerResponse, false);
  assert.equal(decision.contextPolicy, "ambient_buffer");
});

test("admission policy soft-interrupts only the current trigger user correction", () => {
  const config = createTestAppConfig({ whitelist: { enabled: false } });

  const decision = resolveAdmissionDecision({
    config,
    message: createMessage({ text: "不对，是第二段" }),
    relationship: "known",
    groupMatched: true,
    matchedPendingGroupTrigger: true,
    replyToBot: false,
    hasActiveResponse: true
  });

  assert.equal(decision.threadAction, "soft_interrupt");
  assert.equal(decision.interruptPolicy, "soft_interrupt");
  assert.equal(decision.replyDecision, "reply_small");
});

test("admission policy treats active wait-correction as correction before wait_more", () => {
  const config = createTestAppConfig({ whitelist: { enabled: false } });

  const decision = resolveAdmissionDecision({
    config,
    message: createMessage({ text: "等下不对，是第二段" }),
    relationship: "known",
    groupMatched: true,
    matchedPendingGroupTrigger: true,
    replyToBot: false,
    hasActiveResponse: true
  });

  assert.equal(decision.threadAction, "soft_interrupt");
  assert.equal(decision.interruptPolicy, "soft_interrupt");
  assert.equal(decision.replyDecision, "reply_small");
});

test("admission policy queues another user's mention while a response is active", () => {
  const config = createTestAppConfig({ whitelist: { enabled: false } });

  const decision = resolveAdmissionDecision({
    config,
    message: createMessage({
      userId: "u2",
      senderName: "Bob",
      text: "@bot 另一个问题",
      isAtMentioned: true
    }),
    relationship: "known",
    groupMatched: true,
    matchedPendingGroupTrigger: false,
    replyToBot: false,
    hasActiveResponse: true
  });

  assert.equal(decision.threadAction, "queue_next_thread");
  assert.equal(decision.interruptPolicy, "queue");
  assert.equal(decision.replyDecision, "no_reply");
});
