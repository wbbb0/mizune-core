import test from "node:test";
import assert from "node:assert/strict";
import { sessionToolHandlers } from "../../src/llm/tools/conversation/sessionTools.ts";
import { createSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { getBuiltinTools } from "../../src/llm/tools/index.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function createContext(input: { type: "private" | "group"; relationship: "owner" | "known" }) {
  const sessionId = input.type === "group" ? "qqbot:g:100" : "qqbot:p:100";
  const manager = new SessionManager({} as never);
  manager.restorePersistedSession({
    ...createSessionState({ id: sessionId, type: input.type }),
    pendingMessages: [],
    internalTranscript: []
  } as never);
  const persisted: string[] = [];
  return {
    sessionId,
    manager,
    persisted,
    context: {
      relationship: input.relationship,
      lastMessage: { sessionId, userId: "known", senderName: "Known" },
      sessionManager: manager,
      persistSession(_sessionId: string, reason: string) {
        persisted.push(reason);
      }
    } as any
  };
}

test("private user can set and clear current chat identity", async () => {
  const harness = createContext({ type: "private", relationship: "known" });
  const patched = JSON.parse(String(await sessionToolHandlers.patch_current_chat_identity!(
    { id: "tool-1", type: "function", function: { name: "patch_current_chat_identity", arguments: "{}" } },
    { name: "小岚", identity: "摄影师", voiceStyle: "随意" },
    harness.context
  )));
  assert.equal(patched.ok, true);
  assert.deepEqual(patched.profile, { name: "小岚", identity: "摄影师", voiceStyle: "随意" });
  assert.match(patched.instruction, /本轮/);
  assert.deepEqual(harness.manager.getSession(harness.sessionId).botProfile, patched.profile);

  const cleared = JSON.parse(String(await sessionToolHandlers.clear_current_chat_identity!(
    { id: "tool-2", type: "function", function: { name: "clear_current_chat_identity", arguments: "{}" } },
    { fields: ["identity"] },
    harness.context
  )));
  assert.deepEqual(cleared.profile, { name: "小岚", voiceStyle: "随意" });
  assert.deepEqual(harness.persisted, [
    "session_bot_profile_patched_by_tool",
    "session_bot_profile_cleared_by_tool"
  ]);
});

test("group identity writes are owner-only", async () => {
  const known = createContext({ type: "group", relationship: "known" });
  const denied = JSON.parse(String(await sessionToolHandlers.patch_current_chat_identity!(
    { id: "tool-3", type: "function", function: { name: "patch_current_chat_identity", arguments: "{}" } },
    { name: "群聊身份" },
    known.context
  )));
  assert.match(denied.error, /owner/);
  assert.equal(known.manager.getSession(known.sessionId).botProfile, null);

  const owner = createContext({ type: "group", relationship: "owner" });
  const allowed = JSON.parse(String(await sessionToolHandlers.patch_current_chat_identity!(
    { id: "tool-4", type: "function", function: { name: "patch_current_chat_identity", arguments: "{}" } },
    { name: "群聊身份" },
    owner.context
  )));
  assert.equal(allowed.ok, true);
  assert.deepEqual(owner.manager.getSession(owner.sessionId).botProfile, { name: "群聊身份" });
});

test("chat identity tools are visible in normal chat and hidden in profile draft mode", () => {
  const config = createTestAppConfig();
  const normalNames = getBuiltinTools("known", null, config, {
    operationMode: { kind: "normal" }
  }).map((tool) => tool.function.name);
  assert.ok(normalNames.includes("patch_current_chat_identity"));
  assert.ok(normalNames.includes("clear_current_chat_identity"));

  const draftNames = getBuiltinTools("owner", null, config, {
    operationMode: {
      kind: "persona_config",
      draft: { name: "", temperament: "", voiceStyle: "" }
    }
  }).map((tool) => tool.function.name);
  assert.equal(draftNames.includes("patch_current_chat_identity"), false);
  assert.equal(draftNames.includes("clear_current_chat_identity"), false);
});
