import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import pino from "pino";
import { createRuntimeMessageIngress } from "../../src/app/runtime/messageIngress.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import type { ParsedIncomingMessage } from "../../src/services/messaging/incomingMessage.ts";

function context(id: string): ParsedIncomingMessage {
  return { source: "qq_official", channelId: "qq_official.app", contextOnly: true,
    sourceRef: { platform: "qq_official", connectionId: "qq_official.app", messageId: id },
    chatType: "group", groupId: "group", userId: id, senderName: id, text: id,
    contentParts: [{ kind: "text", text: id }], images: [], emojiSources: [], audioSources: [], audioIds: [],
    imageIds: [], emojiIds: [], forwardIds: [], replyMessageId: null,
    mentionUserIds: [], mentionedAll: false, isAtMentioned: false };
}

function fixture(ensureUserIdentity: (input: { externalId: string }) => Promise<{ internalUserId: string }>) {
  const config = createTestAppConfig();
  const sessionManager = new SessionManager(config);
  const forbidden = () => { throw new Error("passive context cannot execute active work"); };
  const services = {
    config, sessionManager, logger: pino({ level: "silent" }),
    userIdentityStore: { ensureUserIdentity },
    userStore: { touchSeenUser: async () => ({ relationship: "known" }) },
    setupStore: { get: async () => ({ state: "ready" }) },
    audioStore: { registerSources: async (sources: string[]) => { assert.deepEqual(sources, []); return []; } },
    chatFileStore: { importRemoteSource: forbidden }
  };
  const ingress = createRuntimeMessageIngress({ services,
    directCommandDeps: { ...services, onebotSendImmediateText: forbidden, flushSession: forbidden },
    persistSession: () => undefined
  } as unknown as Parameters<typeof createRuntimeMessageIngress>[0]);
  return { ingress, sessionManager };
}

test("official ingress records earlier context before later messages even when identity resolution is slow", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  const { ingress, sessionManager } = fixture(async input => {
    started.push(input.externalId);
    if (input.externalId === "first") await gate;
    return { internalUserId: input.externalId };
  });
  const first = ingress.handleIncomingMessage(context("first"), { kind: "qq_official" });
  const second = ingress.handleIncomingMessage(context("second"), { kind: "qq_official" });
  try {
    await setImmediate();
    assert.deepEqual(started, ["first"]);
  } finally { release(); }
  await Promise.all([first, second]);
  const items = sessionManager.getSession("qq_official.app:g:group").internalTranscript;
  assert.deepEqual(items.map(item => item.kind === "user_message" ? item.text : item.kind), ["first", "second"]);
});

test("a failed official input does not prevent subsequent context from being stored", async () => {
  const { ingress, sessionManager } = fixture(async input => {
    if (input.externalId === "failed") throw new Error("synthetic identity failure");
    return { internalUserId: input.externalId };
  });
  const failed = assert.rejects(ingress.handleIncomingMessage(context("failed"), { kind: "qq_official" }), /synthetic identity failure/);
  const later = ingress.handleIncomingMessage(context("later"), { kind: "qq_official" });
  await Promise.all([failed, later]);
  const items = sessionManager.getSession("qq_official.app:g:group").internalTranscript;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind === "user_message" && items[0].text, "later");
});
