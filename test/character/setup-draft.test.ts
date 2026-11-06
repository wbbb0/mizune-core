import test from "node:test";
import assert from "node:assert/strict";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { characterRepository } from "../../src/character/repository.ts";
import { characterStages, type CharacterStage } from "../../src/character/model.ts";
import { formatCharacterDraft } from "../../src/character/draftFormatting.ts";
import { characterPrompt } from "../../src/character/prompt.ts";
import { createBuiltinToolExecutor, getBuiltinToolNames } from "../../src/llm/tools/index.ts";
import { listTurnToolsets } from "../../src/llm/tools/toolsetSelectionPolicy.ts";
import { resolveSessionBoundaryToolNames } from "../../src/llm/tools/toolsetBoundary.ts";
import { setupDraftToolHandlers } from "../../src/llm/tools/conversation/setupDraftTools.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";

const sessionId = "web:character-draft-test";
const modeId = "stateful_rp";
const call = { id: "send-draft", type: "function" as const, function: { name: "send_setup_draft", arguments: "{}" } };

function fixture(stage: CharacterStage, delivery: "web" | "onebot" = "web", targetId = sessionId) {
  const sessionId = targetId;
  const config = createTestAppConfig();
  const store = characterRepository(config.dataDir);
  const manager = new SessionManager(config);
  manager.ensureSession({ id: sessionId, type: "private", source: "web" });
  manager.setModeId(sessionId, modeId);
  const draft = store.begin(sessionId, stage, "setup", modeId);
  manager.setOperationMode(sessionId, { kind: "character_config", stage });
  const texts: string[] = [];
  const histories: string[] = [];
  const tasks: Array<() => Promise<void>> = [];
  const ctx = {
    config, relationship: "owner", currentUser: null, replyDelivery: delivery,
    lastMessage: { sessionId, userId: "owner", senderName: "测试用户" },
    sessionManager: manager,
    messageQueue: { enqueueText: ({ send }: { send: () => Promise<void> }) => new Promise<void>((resolve, reject) => {
      tasks.push(async () => { try { await send(); resolve(); } catch (error) { reject(error); } });
    }) },
    committedTextSink: { commitText(text: string) { texts.push(text); } },
    messaging: { async sendText(_target: unknown, text: string) { texts.push(text); return { platform: "onebot", messageId: 123 }; } }
  } as unknown as BuiltinToolContext;
  // 只观察本测试产生的历史，不读取任何实例数据。
  manager.appendAssistantHistory = (_id, input) => { histories.push(input.text); };
  const operationMode = manager.getOperationMode(sessionId);
  const toolsets = () => listTurnToolsets({ config, relationship: ctx.relationship, currentUser: null, modelRef: [], includeDebugTools: false,
    modeId, operationMode, visibilityContext: { sessionId }, profileToolScope: "normal" });
  const executor = () => createBuiltinToolExecutor(ctx, { availableToolNames: toolsets().flatMap(item => item.toolNames), operationMode, setupMode: true });
  const send = async (args: Record<string, unknown> = {}) => {
    const result = await executor()(call, args);
    return JSON.parse(typeof result === "string" ? result : result.content);
  };
  const flush = async () => { for (const task of tasks.splice(0)) await task(); };
  return { config, store, manager, draft, texts, histories, tasks, ctx, toolsets, executor, send, flush };
}

for (const stage of characterStages) {
  test(`${stage} 的草稿工具从目录、工具定义到执行边界一致可用，并发送本阶段完整草稿`, async () => {
    const f = fixture(stage);
    const names = f.toolsets().flatMap(item => item.toolNames);
    assert.ok(names.includes(call.function.name));
    assert.ok(getBuiltinToolNames("owner", null, f.config, { availableToolNames: names, visibilityContext: { sessionId } }).includes(call.function.name));
    assert.ok(resolveSessionBoundaryToolNames(modeId, { overrides: {} }, { kind: "character_config", stage }).has(call.function.name));
    assert.match(characterPrompt(f.config.dataDir, sessionId, modeId).join("\n"), /send_setup_draft/);
    const before = f.store.draft(sessionId)!;
    assert.deepEqual(await f.send(), { ok: true, queued: true });
    assert.equal(f.texts.length, 0);
    await f.flush();
    assert.equal(f.texts.length, 1);
    assert.equal(f.texts[0], formatCharacterDraft(before));
    assert.deepEqual(f.histories, f.texts);
    assert.deepEqual(f.store.draft(sessionId), before);
    assert.deepEqual(f.store.profile().confirmed, []);
    assert.doesNotMatch(f.texts[0]!, /baseRevision|profileRevision|"touched"|"introduction"/);
  });
}

test("已发布档案不替代当前草稿，补充说明只追加，所有长描述和集合条目完整保留", async () => {
  const f = fixture("social");
  f.store.cancel(sessionId);
  const previous = f.store.begin("published", "social", "config", modeId);
  f.store.edit("published", modeId, "social.identity", "patch", { occupation: "已发布职业" }, undefined, previous.id);
  f.store.confirm("published", modeId);
  const draft = f.store.begin(sessionId, "social", "config", modeId);
  f.store.edit(sessionId, modeId, "social.identity", "patch", { occupation: "草稿职业", socialRoles: ["角色甲", "角色乙"] }, undefined, draft.id);
  const description = "第一行说明\n" + "图中明确可见的细节。".repeat(900) + "\n末尾不可丢失";
  for (let index = 1; index <= 2; index++) f.store.edit(sessionId, modeId, "social.referenceImages", "upsert", {
    id: `ref-${index}`, fileId: `file_${index}`, label: `设定图${index}`, subject: index === 1 ? null : "右侧角色", description
  }, undefined, draft.id);
  const before = f.store.draft(sessionId)!;
  assert.deepEqual(await f.send({ content: "请重点核对职业。" }), { ok: true, queued: true });
  await f.flush();
  const text = f.texts[0]!;
  for (const value of ["草稿职业", "角色甲", "角色乙", "设定图1", "设定图2", "file_1", "file_2", "右侧角色", "末尾不可丢失"]) assert.ok(text.includes(value));
  assert.equal(text.split("末尾不可丢失").length - 1, 2);
  assert.ok(!text.includes("已发布职业"));
  assert.ok(text.includes(description.replaceAll("\n", "\n      ")));
  assert.match(text, /补充说明：\n请重点核对职业。$/);
  assert.deepEqual(f.store.draft(sessionId), before);
});

test("会话状态完整保留零值、布尔值、空值与空集合，且不混入已确认设定", async () => {
  const f = fixture("state");
  f.store.edit(sessionId, modeId, "session.social.currentMood", "set", "平静", undefined, f.draft.id);
  f.store.edit(sessionId, modeId, "session.simulation.body.activePhysiology.menstrualCycle", "patch", { lastStartDate: null }, undefined, f.draft.id);
  await f.send(); await f.flush();
  const text = f.texts[0]!;
  assert.ok(text.includes("平静"));
  for (const value of ["：0", "：否", "（未填写）", "（空）"]) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /基础人格初始化草稿|社交设定初始化草稿|具身设定与初始衣柜初始化草稿/);
});

test("草稿取消后不能把 content 当成完整草稿发送", async () => {
  const f = fixture("persona");
  f.store.cancel(sessionId);
  const result = await f.send({ content: "模型自行填写的替代文本" });
  assert.match(result.error, /草稿已取消|阶段已变化/);
  assert.equal(f.tasks.length, 0);
});

test("仅有发送工具的执行器也绑定原草稿 ID，取消重建同阶段后拒绝旧调用", async () => {
  const f = fixture("persona");
  const execute = createBuiltinToolExecutor(f.ctx, { availableToolNames: [call.function.name] });
  f.store.cancel(sessionId); f.store.begin(sessionId, "persona", "setup", modeId);
  const result = await execute(call, {});
  assert.match(typeof result === "string" ? result : result.content, /草稿已取消|阶段已变化/);
  assert.equal(f.tasks.length, 0);
});

for (const mutation of ["cancel", "replace", "edit", "confirm", "mode", "modeId", "clear"] as const) {
  test(`草稿排队后 ${mutation} 不再发送旧快照或追加历史`, async () => {
    const f = fixture("persona");
    await f.send();
    if (mutation === "cancel") f.store.cancel(sessionId);
    if (mutation === "replace") { f.store.cancel(sessionId); f.store.begin(sessionId, "persona", "setup", modeId); }
    if (mutation === "edit") f.store.edit(sessionId, modeId, "persona.name", "set", "新名字", undefined, f.draft.id);
    if (mutation === "confirm") { f.store.confirm(sessionId, modeId); f.store.begin(sessionId, "social", "setup", modeId); f.manager.setOperationMode(sessionId, { kind: "character_config", stage: "social" }); }
    if (mutation === "mode") f.manager.setOperationMode(sessionId, { kind: "normal" });
    if (mutation === "modeId") f.manager.setModeId(sessionId, "assistant");
    if (mutation === "clear") f.manager.clearSession(sessionId);
    await f.flush();
    assert.deepEqual(f.texts, []); assert.deepEqual(f.histories, []);
  });
}

test("非 owner 看不到发送工具，直接调用也无法读取角色草稿", async () => {
  const f = fixture("persona");
  f.ctx.relationship = "known";
  assert.ok(!f.toolsets().some(item => item.toolNames.includes(call.function.name)));
  const result = await setupDraftToolHandlers.send_setup_draft!(call, {}, f.ctx);
  assert.match(String(result), /仅 owner/);
  assert.equal(f.tasks.length, 0);
});

test("当前模式不支持草稿所在层时拒绝发送", async () => {
  const f = fixture("embodiment");
  f.manager.setModeId(sessionId, "assistant");
  const result = await f.send();
  assert.match(result.error, /配置阶段已变化/);
  assert.equal(f.tasks.length, 0);
});

test("普通游玩工具边界没有草稿发送能力", () => {
  assert.ok(!resolveSessionBoundaryToolNames(modeId, { overrides: {} }, { kind: "normal" }).has(call.function.name));
});

test("通过现有消息投递入口发送角色草稿，补充说明不触发模型重写", async () => {
  const f = fixture("persona", "onebot", "bot:p:123");
  assert.deepEqual(await f.send({ content: "附注" }), { ok: true, queued: true });
  await f.flush();
  assert.equal(f.texts.length, 1);
  assert.match(f.texts[0]!, /基础人格初始化草稿/);
  assert.match(f.texts[0]!, /补充说明：\n附注$/);
  assert.deepEqual(f.histories, f.texts);
  assert.equal(f.manager.getSession("bot:p:123").sentMessages.length, 1);
});

for (const delivery of ["web", "onebot"] as const) {
  test(`${delivery} 已实际投递后草稿变化，仍如实记录发送历史与回执`, async () => {
    const targetId = delivery === "web" ? sessionId : "bot:p:123";
    const f = fixture("persona", delivery, targetId);
    const delivered = (text: string) => {
      f.texts.push(text);
      f.store.edit(targetId, modeId, "persona.name", "set", "投递期间修改的新名字", undefined, f.draft.id);
    };
    Object.assign(f.ctx.committedTextSink!, { commitText: async (text: string) => { delivered(text); } });
    Object.assign(f.ctx.messaging!, { sendText: async (_target: unknown, text: string) => { delivered(text); return { platform: "onebot", messageId: 123 }; } });
    await f.send(); await f.flush();
    assert.equal(f.texts.length, 1);
    assert.deepEqual(f.histories, f.texts);
    assert.equal(f.manager.getSession(targetId).sentMessages.length, delivery === "onebot" ? 1 : 0);
    assert.doesNotMatch(f.texts[0]!, /投递期间修改的新名字/);
  });
}

test("草稿发送参数仍通过统一配置输入校验", async () => {
  const f = fixture("persona");
  const result = await f.send({ content: { invalid: "object" } });
  assert.equal(result.code, "setup_input_invalid");
  const repeated = await f.send({ content: { invalid: "object" } });
  assert.equal(repeated.repeated, true);
  assert.equal(f.tasks.length, 0);
  assert.deepEqual(await f.send({ content: "改正后的附注" }), { ok: true, queued: true });
  await f.flush();
  assert.match(f.texts[0]!, /改正后的附注/);
});
