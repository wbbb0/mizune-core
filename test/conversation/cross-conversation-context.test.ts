import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { prepareCrossConversationContext, projectSharedChat, publishConversation, readConversationContext } from "../../src/conversation/crossConversationContext.ts";
import { createSessionState, toPersistedSessionState, restoreSessionState } from "../../src/conversation/session/sessionStateFactory.ts";
import { transcriptUserMessageItemSchema, transcriptAssistantMessageItemSchema } from "../../src/conversation/session/transcriptContract.ts";
import { SessionPersistence } from "../../src/conversation/session/sessionPersistence.ts";
import { createSessionTranscriptStore } from "../../src/conversation/session/sessionTranscriptStore.ts";
import { applyCompressedHistoryState, clearSessionState } from "../../src/conversation/session/sessionMutations.ts";
import { estimateTokens } from "../../src/conversation/session/tokenEstimator.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function message(id: string, text: string, role: "user" | "assistant" = "user") {
  const common = { id, groupId: "turn", role, kind: role === "user" ? "user_message" : "assistant_message", llmVisible: true, chatType: "group", userId: "u", senderName: "用户", text, timestampMs: 1 };
  return role === "assistant" ? transcriptAssistantMessageItemSchema.parse(common) : transcriptUserMessageItemSchema.parse({ ...common, audioCount: 0, replyMessageId: null, mentionedAll: false, mentionedSelf: false });
}
function fixture() {
  const a = createSessionState({ id: "a", type: "group" });
  const b = createSessionState({ id: "b", type: "group" });
  b.internalTranscript.push(message("1", "周六去"), message("2", "暂定周六", "assistant"));
  const config = createTestAppConfig({ conversation: { crossConversation: { enabled: true, links: [{ targetSessionId: "a", sourceSessionId: "b", mode: "live" }] } } });
  const signal = new AbortController();
  return { a, b, config, signal, input: { settings: config.conversation.crossConversation, reader: { getSession(id: string) { return id === "a" ? a : b; } }, access: { async canAccessSession() { return true; } }, targetSessionId: "a", requesterUserId: "u", signal: signal.signal } };
}

test("preparation overlaps planning and reads messages only at final rendering", async () => {
  const { b, input } = fixture();
  let release!: () => void;
  input.access.canAccessSession = () => new Promise<boolean>((resolve) => { release = () => resolve(true); });
  const preparation = prepareCrossConversationContext(input);
  b.internalTranscript.push(message("3", "planner 运行期间的新消息"));
  release();
  const prepared = await preparation;
  b.internalTranscript.push(message("4", "最终 prompt 前的新消息"));
  assert.match(prepared.render()!, /最终 prompt 前的新消息/);
  assert.match(prepared.render()!, /planner 运行期间的新消息/);
});

test("disabled sharing does not check access and abort drops prepared context", async () => {
  const { input, signal } = fixture();
  input.settings.enabled = false;
  input.access.canAccessSession = async () => { throw new Error("must not be called"); };
  assert.equal((await prepareCrossConversationContext(input)).render(), null);
  input.settings.enabled = true;
  input.access.canAccessSession = async () => true;
  const prepared = await prepareCrossConversationContext(input);
  signal.abort();
  assert.equal(prepared.render(), null);
});

test("membership timeout and rejection fail closed without delaying indefinitely", async () => {
  const { input } = fixture();
  input.settings.prepareTimeoutMs = 50;
  input.access.canAccessSession = () => new Promise(() => {});
  assert.equal((await prepareCrossConversationContext(input)).render(), null);
  input.access.canAccessSession = async () => { throw new Error("membership unavailable"); };
  assert.equal((await prepareCrossConversationContext(input)).render(), null);
});

test("group destination cannot read private source even when requester can", async () => {
  const { b, input } = fixture();
  b.type = "private";
  assert.equal((await prepareCrossConversationContext(input)).render(), null);
});

test("reference budget includes metadata and long latest message is bounded", async () => {
  const { b, input } = fixture();
  input.settings.maxTokens = 512;
  b.internalTranscript.push(message("3", "长消息".repeat(10000)));
  const text = (await prepareCrossConversationContext(input)).render();
  assert.ok(text);
  assert.ok(estimateTokens(text) <= 512);
  assert.match(text, /已截断/);
});

test("completed view excludes pending next turn and never borrows a newer summary", () => {
  const { b } = fixture();
  assert.equal(readConversationContext(b, "last_completed_reply", 12, 1500).available, false);
  publishConversation(b, 2);
  // Same timestamp intentionally: freshness is determined by message identity.
  b.internalTranscript.push(message("3", "改成周日"));
  b.historySummary = "不能进入旧快照的未来信息";
  const frozen = readConversationContext(b, "last_completed_reply", 12, 1500);
  assert.equal(frozen.hasNewerMessages, true);
  assert.doesNotMatch(JSON.stringify(frozen), /周日|未来信息/);
  assert.match(JSON.stringify(readConversationContext(b, "live", 12, 1500)), /周日/);
});

test("projection excludes reasoning, tools and retracted messages", () => {
  const { b } = fixture();
  b.internalTranscript.push({ ...message("3", "撤回内容"), runtimeExcluded: true });
  b.internalTranscript.push(transcriptAssistantMessageItemSchema.parse({ ...message("4", "可见回答", "assistant"), reasoningContent: "秘密推理", providerMetadata: { hidden: "内部数据" } }));
  const text = JSON.stringify(projectSharedChat(b));
  assert.match(text, /可见回答/);
  assert.doesNotMatch(text, /撤回内容|秘密推理|内部数据/);
});

test("published window survives compression, reload and is invalidated by retraction/reset", async () => {
  const { b, config } = fixture();
  publishConversation(b, 2);
  const snapshot = structuredClone(b.publishedConversation);
  applyCompressedHistoryState(b, { historySummary: "已压缩", transcriptStartIndexToKeep: b.internalTranscript.length });
  assert.deepEqual(b.publishedConversation, snapshot);
  const dir = await mkdtemp(join(tmpdir(), "cross-conversation-test-"));
  try {
    const persistence = new SessionPersistence(dir, pino({ level: "silent" }));
    await persistence.init();
    await persistence.save(toPersistedSessionState(b));
    const loaded = (await persistence.loadAll())[0]!;
    assert.deepEqual(restoreSessionState(loaded).publishedConversation, snapshot);
  } finally { await rm(dir, { recursive: true, force: true }); }
  b.internalTranscript.push(message("3", "新消息"));
  createSessionTranscriptStore(b, config).excludeItem("3", "manual_single", 3);
  assert.deepEqual(b.publishedConversation, snapshot);
  // A current-turn interruption must not invalidate the previous complete turn.
  b.internalTranscript.push(message("2", "暂定周六", "assistant"));
  createSessionTranscriptStore(b, config).excludeItem("2", "manual_single", 3);
  assert.equal(b.publishedConversation, null);
  publishConversation(b, 4);
  clearSessionState(b);
  assert.equal(b.publishedConversation, null);
});


for (const sourceCount of [2, 3]) {
  test(`512-token budget retains useful text with ${sourceCount} sources`, async () => {
    const { b, input } = fixture();
    input.settings.maxTokens = 512;
    input.settings.maxSources = 3;
    input.settings.links = Array.from({ length: sourceCount }, (_, index) => ({ targetSessionId: "a", sourceSessionId: `b${index}`, mode: "live" as const }));
    const getSession = input.reader.getSession;
    input.reader.getSession = (id) => id === "a" ? getSession(id) : { ...b, id };
    const text = (await prepareCrossConversationContext(input)).render();
    assert.ok(text);
    assert.ok(estimateTokens(text) <= 512);
    assert.match(text, /周六/);
    assert.doesNotMatch(text, /"messages":\[\]/);
  });
}

test("authorization timeout retains already checked sources and ignores late ones", async () => {
  const { b, input } = fixture();
  input.settings.prepareTimeoutMs = 50;
  input.settings.links.push({ targetSessionId: "a", sourceSessionId: "c", mode: "live" });
  let release!: (value: boolean) => void;
  input.access = { async canAccessSession(_userId: string, sourceSessionId: string) {
    return sourceSessionId === "b" || await new Promise<boolean>((resolve) => { release = resolve; });
  } } as typeof input.access;
  const getSession = input.reader.getSession;
  input.reader.getSession = (id) => id === "c" ? { ...b, id } : getSession(id);
  const prepared = await prepareCrossConversationContext(input);
  assert.match(prepared.render()!, /"sourceSessionId":"b"/);
  release(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(prepared.render()!, /"sourceSessionId":"c"/);
});
