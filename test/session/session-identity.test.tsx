import assert from "node:assert/strict";
import {
  buildGroupSessionId,
  buildPrivateSessionId,
  buildSessionId,
  deriveParticipantUserId,
  formatSessionDisplayLabel,
  getSessionDisplayInfo,
  getSessionChatType,
  getSessionSource,
  isChatSessionIdentity,
  isWebSessionIdentity,
  parseChatSessionIdentity,
  parseSessionIdentity
} from "../../src/conversation/session/sessionIdentity.ts";

async function runCase(name: string, fn: () => Promise<void> | void) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("build helpers generate stable onebot session ids", () => {
    assert.equal(buildPrivateSessionId("qqbot", "10001"), "qqbot:p:10001");
    assert.equal(buildGroupSessionId("qqbot", "20002"), "qqbot:g:20002");
    assert.equal(buildSessionId({ channelId: "qqbot", chatType: "private", userId: "10001" as const }), "qqbot:p:10001");
    assert.equal(buildSessionId({ channelId: "qqbot", chatType: "group", userId: "10001" as const, groupId: "20002" }), "qqbot:g:20002");
  });

  await runCase("parseSessionIdentity distinguishes private group web and unknown ids", () => {
    assert.deepEqual(parseSessionIdentity("qqbot:p:10001"), {
      id: "qqbot:p:10001",
      kind: "private",
      channelId: "qqbot",
      userId: "10001",
      source: "onebot"
    });
    assert.deepEqual(parseSessionIdentity("qqbot:g:20002"), {
      id: "qqbot:g:20002",
      kind: "group",
      channelId: "qqbot",
      groupId: "20002",
      source: "onebot"
    });
    assert.deepEqual(parseSessionIdentity("web:panel"), {
      id: "web:panel",
      kind: "web",
      value: "panel",
      source: "web"
    });
    assert.deepEqual(parseSessionIdentity("custom-id"), {
      id: "custom-id",
      kind: "unknown",
      value: "custom-id",
      source: "onebot"
    });
  });

  await runCase("parseChatSessionIdentity only accepts chat-backed private and group ids", () => {
    assert.deepEqual(parseChatSessionIdentity("qqbot:p:10001"), {
      id: "qqbot:p:10001",
      kind: "private",
      channelId: "qqbot",
      userId: "10001",
      source: "onebot"
    });
    assert.deepEqual(parseChatSessionIdentity("qqbot:g:20002"), {
      id: "qqbot:g:20002",
      kind: "group",
      channelId: "qqbot",
      groupId: "20002",
      source: "onebot"
    });
    assert.equal(parseChatSessionIdentity("web:panel"), null);
    assert.equal(parseChatSessionIdentity("custom-id"), null);
  });

  await runCase("chat type source and participant derivation stay centralized", () => {
    assert.equal(getSessionChatType("qqbot:p:10001"), "private");
    assert.equal(getSessionChatType("qqbot:g:20002"), "group");
    assert.equal(getSessionChatType("web:panel"), "unknown");

    assert.equal(getSessionSource("qqbot:p:10001"), "onebot");
    assert.equal(getSessionSource("web:panel"), "web");

    assert.equal(deriveParticipantUserId("qqbot:p:10001", "private"), "10001");
    assert.equal(deriveParticipantUserId("qqbot:g:20002", "group"), "20002");
    assert.equal(deriveParticipantUserId("web:panel", "private"), "panel");
    assert.equal(deriveParticipantUserId("opaque", "group"), "opaque");
  });

  await runCase("display helpers centralize participant fallback and source labels", () => {
    assert.equal(isChatSessionIdentity("qqbot:p:10001"), true);
    assert.equal(isChatSessionIdentity("web:panel"), false);
    assert.equal(isWebSessionIdentity("web:panel"), true);
    assert.equal(isWebSessionIdentity("qqbot:g:20002"), false);

    assert.deepEqual(
      getSessionDisplayInfo({
        sessionId: "qqbot:g:20002",
        participantLabel: null,
        participantUserId: "20002"
      }),
      {
        participantLabel: "20002",
        sourceLabel: "OneBot",
        kindLabel: "群聊",
        sessionLabel: "群聊 20002"
      }
    );

    assert.equal(
      formatSessionDisplayLabel({
        sessionId: "web:panel",
        participantLabel: "Alice",
        participantUserId: "web-user"
      }),
      "Web Alice"
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
