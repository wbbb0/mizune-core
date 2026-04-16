import assert from "node:assert/strict";
import {
  buildGroupSessionId,
  buildPrivateSessionId,
  buildSessionId,
  deriveParticipantUserId,
  getSessionChatType,
  getSessionSource,
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
    assert.equal(buildPrivateSessionId("10001"), "private:10001");
    assert.equal(buildGroupSessionId("20002"), "group:20002");
    assert.equal(buildSessionId({ chatType: "private", userId: "10001" as const }), "private:10001");
    assert.equal(buildSessionId({ chatType: "group", userId: "10001" as const, groupId: "20002" }), "group:20002");
  });

  await runCase("parseSessionIdentity distinguishes private group web and unknown ids", () => {
    assert.deepEqual(parseSessionIdentity("private:10001"), {
      id: "private:10001",
      kind: "private",
      userId: "10001",
      source: "onebot"
    });
    assert.deepEqual(parseSessionIdentity("group:20002"), {
      id: "group:20002",
      kind: "group",
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
    assert.deepEqual(parseChatSessionIdentity("private:10001"), {
      id: "private:10001",
      kind: "private",
      userId: "10001",
      source: "onebot"
    });
    assert.deepEqual(parseChatSessionIdentity("group:20002"), {
      id: "group:20002",
      kind: "group",
      groupId: "20002",
      source: "onebot"
    });
    assert.equal(parseChatSessionIdentity("web:panel"), null);
    assert.equal(parseChatSessionIdentity("custom-id"), null);
  });

  await runCase("chat type source and participant derivation stay centralized", () => {
    assert.equal(getSessionChatType("private:10001"), "private");
    assert.equal(getSessionChatType("group:20002"), "group");
    assert.equal(getSessionChatType("web:panel"), "unknown");

    assert.equal(getSessionSource("private:10001"), "onebot");
    assert.equal(getSessionSource("web:panel"), "web");

    assert.equal(deriveParticipantUserId("private:10001", "private"), "10001");
    assert.equal(deriveParticipantUserId("group:20002", "group"), "20002");
    assert.equal(deriveParticipantUserId("web:panel", "private"), "panel");
    assert.equal(deriveParticipantUserId("opaque", "group"), "opaque");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
