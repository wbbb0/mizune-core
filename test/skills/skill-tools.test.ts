import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import type { SessionOperationMode } from "../../src/conversation/session/sessionOperationMode.ts";
import { createBuiltinToolExecutor, getBuiltinTools } from "../../src/llm/tools/index.ts";
import { executeBuiltinToolHandler } from "../../src/llm/tools/toolRegistry.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";
import { SKILL_TOOL_NAMES, SKILL_MAINTENANCE_TOOL_NAMES } from "../../src/skills/skillPolicy.ts";
import { getSkillStore } from "../../src/skills/skillStore.ts";
import { beginSkillTask } from "../../src/skills/skillRuntime.ts";
import { characterRepository } from "../../src/character/repository.ts";
import { startSkillDraft, readSkillDraft, cancelSkillDraft, writeSkillDraft } from "../../src/skills/skillDrafts.ts";
import type { SkillWriteInput } from "../../src/types/skills.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function input(revision: number | null = null): SkillWriteInput {
  return {
    expectedRevision: revision, document: "---\nname: test-guide\ndescription: 测试技能工具链路。\n---\n操作前确认需求，操作后验证结果。",
    resources: { "references/detail.md": "补充操作细节。" }, toolsetIds: ["time_utils"],
    userPolicy: "auto", modelEditable: true, modelPaused: false, changeReason: "测试维护链路"
  };
}
function fixture(t: TestContext, modeId = "assistant", maintenanceEnabled = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "skill-tools-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = createTestAppConfig({ dataDir, skills: { modelMaintenanceEnabled: maintenanceEnabled } });
  const sessionManager = new SessionManager(config);
  const sessionId = "web:skill-tools";
  sessionManager.ensureSession({ id: sessionId, type: "private", source: "web" });
  sessionManager.setModeId(sessionId, modeId, { appendSwitchMarker: false });
  const store = getSkillStore(config);
  store.write("test-guide", input(), "user");
  const context = {
    config, sessionManager, relationship: "owner", currentUser: null, replyDelivery: "web",
    lastMessage: { sessionId, userId: "owner", senderName: "Owner" },
    skillAccess: beginSkillTask(config, sessionId, "test-task")
  } as unknown as BuiltinToolContext;
  const call = (name: string) => ({ id: name, type: "function" as const, function: { name, arguments: "{}" } });
  const execute = (options?: Parameters<typeof createBuiltinToolExecutor>[1]) => {
    const executor = createBuiltinToolExecutor(context, options);
    return async (name: string, args: unknown = {}) => {
      const result = await executor(call(name), args);
      return JSON.parse(typeof result === "string" ? result : result.content);
    };
  };
  return { config, sessionManager, sessionId, store, context, call, execute };
}

for (const modeId of ["assistant", "rp_assistant"]) {
  test(`${modeId} 真实会话的六个技能工具均通过执行期边界`, async t => {
    const f = fixture(t, modeId);
    const run = f.execute({ availableToolNames: SKILL_TOOL_NAMES });
    assert.match((await run("list_skills")).catalog, /test-guide/);
    assert.equal((await run("load_skill", { id: "test-guide", reason: "测试" })).loaded, true);
    assert.equal((await run("read_skill_resource", { id: "test-guide", path: "references/detail.md" })).content, "补充操作细节。");
    assert.equal((await run("get_skill", { id: "test-guide" })).skill.revision, 1);
    assert.equal((await run("save_skill", { id: "test-guide", ...input(1) })).skill.revision, 2);
    assert.equal((await run("set_skill_paused", { id: "test-guide", expectedRevision: 2, paused: true, reason: "验证暂停" })).skill.modelPaused, true);
  });
}

const excludedOperations: SessionOperationMode[] = [
  { kind: "persona_setup", draft: {} as never }, { kind: "persona_config", draft: {} as never },
  { kind: "character_config", stage: "persona" },
  { kind: "mode_setup", modeId: "rp_assistant", draft: {} as never },
  { kind: "mode_config", modeId: "scenario_host", draft: {} as never }
];
for (const operationMode of excludedOperations) {
  test(`${operationMode.kind} 不论是否提供工具名单，都拒绝技能 schema 与执行`, async t => {
    const f = fixture(t);
    f.sessionManager.setOperationMode(f.sessionId, operationMode);
    for (const availableToolNames of [undefined, SKILL_TOOL_NAMES]) {
      const options = { operationMode, ...(availableToolNames ? { availableToolNames } : {}) };
      assert.equal(getBuiltinTools("owner", f.config, undefined, options).some(tool => SKILL_TOOL_NAMES.includes(tool.function.name)), false);
      for (const name of SKILL_TOOL_NAMES) assert.ok((await f.execute(options)(name)).error);
    }
    const result = await executeBuiltinToolHandler(f.call("get_skill"), { id: "test-guide" }, f.context);
    assert.match(String(result), /配置阶段不允许/);
  });
}

test("自动 setup 与 stateful_rp 普通轮次隔离技能，技能草稿可显式启用", async t => {
  const f = fixture(t, "stateful_rp");
  assert.equal(getBuiltinTools("owner", f.config, undefined, { modeId: "stateful_rp" }).some(tool => SKILL_TOOL_NAMES.includes(tool.function.name)), false);
  assert.ok((await f.execute()("list_skills")).error);
  startSkillDraft(f.config, f.sessionId, "test-guide");
  const operationMode = { kind: "skill_config" as const, skillId: "test-guide" };
  f.sessionManager.setOperationMode(f.sessionId, operationMode);
  assert.equal((await f.execute()("get_skill", { id: "test-guide" })).draft.id, "test-guide");
  for (const availableToolNames of [undefined, SKILL_TOOL_NAMES]) {
    const options = { modeId: "stateful_rp", operationMode, setupMode: true, ...(availableToolNames ? { availableToolNames } : {}) };
    assert.equal(getBuiltinTools("owner", f.config, undefined, options).some(tool => SKILL_TOOL_NAMES.includes(tool.function.name)), false);
    assert.ok((await f.execute(options)("get_skill", { id: "test-guide" })).error);
  }
});

test("关闭自主维护隐藏且拒绝维护工具，草稿模式可维护新草稿并立即校验", async t => {
  const f = fixture(t, "assistant", false);
  const names = () => getBuiltinTools("owner", f.config, undefined, { operationMode: f.sessionManager.getOperationMode(f.sessionId) }).map(tool => tool.function.name);
  assert.ok(SKILL_MAINTENANCE_TOOL_NAMES.every(name => !names().includes(name)));
  for (const name of SKILL_MAINTENANCE_TOOL_NAMES) assert.ok((await f.execute()(name)).error);
  startSkillDraft(f.config, f.sessionId, "new-guide");
  f.sessionManager.setOperationMode(f.sessionId, { kind: "skill_config", skillId: "new-guide" });
  assert.ok(SKILL_MAINTENANCE_TOOL_NAMES.every(name => names().includes(name)));
  const run = f.execute();
  const before = readSkillDraft(f.config, f.sessionId)!;
  assert.equal((await run("get_skill", { id: "new-guide" })).draft.id, "new-guide");
  await assert.rejects(run("get_skill", { id: "test-guide" }), /草稿ID或版本不匹配/);
  await assert.rejects(run("save_skill", { id: "new-guide", ...input(), document: "非法文档" }), /frontmatter/);
  assert.deepEqual(readSkillDraft(f.config, f.sessionId), before);
  const edited = { ...input(), document: input().document.replaceAll("test-guide", "new-guide") };
  assert.equal((await run("save_skill", { id: "new-guide", ...edited })).draft, true);
  assert.equal((await run("set_skill_paused", { id: "new-guide", expectedRevision: null, paused: true, reason: "草稿暂停" })).draft, true);
  assert.equal(readSkillDraft(f.config, f.sessionId)?.input.modelPaused, true);
  assert.equal(f.store.get("new-guide"), null);
  const pauseSchema = getBuiltinTools("owner", f.config, undefined, { operationMode: f.sessionManager.getOperationMode(f.sessionId) }).find(tool => tool.function.name === "set_skill_paused")!.function.parameters as { properties: { expectedRevision: { type: string[] } } };
  assert.ok(pauseSchema.properties.expectedRevision.type.includes("null"));
});

test("非法草稿结构不覆盖原草稿，正式写入复用相同校验", t => {
  const f = fixture(t);
  const before = startSkillDraft(f.config, f.sessionId, "test-guide");
  for (const invalid of [
    { resources: { "references/../escape.md": "非法路径" } }, { toolsetIds: ["unknown-toolset"] },
    { userPolicy: "unknown" }, { modelEditable: "true" }, { modelPaused: true, modelPauseReason: " " },
    { expectedRevision: 0 }, { modelPauseReason: 42 }, { changeReason: 42 }
  ]) {
    const value = { ...before.input, ...invalid } as SkillWriteInput;
    assert.throws(() => writeSkillDraft(f.config, f.sessionId, { id: before.id, input: value }));
    assert.throws(() => f.store.write(before.id, value, "user"));
    assert.deepEqual(readSkillDraft(f.config, f.sessionId), before);
    assert.equal(f.store.get(before.id)?.revision, 1);
  }
});

test("等待身份校验的旧调用取消后不能写入同 ID 新草稿", async t => {
  const f = fixture(t);
  startSkillDraft(f.config, f.sessionId, "test-guide");
  f.sessionManager.setOperationMode(f.sessionId, { kind: "skill_config", skillId: "test-guide" });
  const generation = f.sessionManager.beginSyntheticGeneration(f.sessionId);
  f.context.abortSignal = generation.abortController.signal;
  let release!: () => void;
  const authorized = new Promise<void>(resolve => { release = resolve; });
  f.context.resolveActorAuthorization = async () => { await authorized; return { relationship: "owner", currentUser: null }; };
  const pending = f.execute()("save_skill", { id: "test-guide", ...input(1), document: input().document + "旧调用的迟到内容。" });
  f.sessionManager.interruptResponse(f.sessionId);
  cancelSkillDraft(f.config, f.sessionId);
  f.sessionManager.setOperationMode(f.sessionId, { kind: "normal" });
  const fresh = startSkillDraft(f.config, f.sessionId, "test-guide");
  f.sessionManager.setOperationMode(f.sessionId, { kind: "skill_config", skillId: "test-guide" });
  release();
  await assert.rejects(pending, /abort/i);
  assert.deepEqual(readSkillDraft(f.config, f.sessionId), fresh);
});

test("操作身份包含技能 ID，且运行中撤回配置/owner 权限立即拒绝", async t => {
  const f = fixture(t);
  startSkillDraft(f.config, f.sessionId, "test-guide");
  f.sessionManager.setOperationMode(f.sessionId, { kind: "skill_config", skillId: "test-guide" });
  const old = f.execute();
  f.sessionManager.setOperationMode(f.sessionId, { kind: "skill_config", skillId: "another-guide" });
  assert.match((await old("get_skill", { id: "test-guide" })).error, /配置阶段已变化/);
  f.sessionManager.setOperationMode(f.sessionId, { kind: "normal" });
  const run = f.execute();
  f.config.skills.modelMaintenanceEnabled = false;
  assert.ok((await run("save_skill", { id: "test-guide", ...input(1) })).error);
  f.config.skills.modelMaintenanceEnabled = true;
  f.context.resolveActorAuthorization = async () => ({ relationship: "known", currentUser: null });
  assert.ok((await run("save_skill", { id: "test-guide", ...input(1) })).error);
  f.config.skills.enabled = false;
  assert.ok((await run("list_skills")).error);
});

test("模型模式切换入口与管理 API 一致，不得覆盖技能草稿", async t => {
  const f = fixture(t);
  const before = startSkillDraft(f.config, f.sessionId, "test-guide");
  f.sessionManager.setOperationMode(f.sessionId, { kind: "skill_config", skillId: "test-guide" });
  const run = f.execute({ availableToolNames: ["switch_session_mode"] });
  await assert.rejects(run("switch_session_mode", { modeId: "stateful_rp" }), /请先确认或取消当前技能配置草稿/);
  assert.equal(f.sessionManager.getModeId(f.sessionId), "assistant");
  assert.equal(f.sessionManager.getOperationMode(f.sessionId).kind, "skill_config");
  assert.deepEqual(readSkillDraft(f.config, f.sessionId), before);
  // 即使流程状态异常恢复为 normal，残留草稿也不能被另一入口绕过。
  f.sessionManager.setOperationMode(f.sessionId, { kind: "normal" });
  await assert.rejects(f.execute({ availableToolNames: ["switch_session_mode"] })("switch_session_mode", { modeId: "stateful_rp" }), /技能配置草稿/);
  assert.equal(f.sessionManager.getModeId(f.sessionId), "assistant");
});

test("模型切换模式等待状态初始化时，新开启的技能草稿不能被覆盖", async t => {
  const f = fixture(t);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.context.scenarioHostStateStore = { async ensureForSession() { await waiting; } } as unknown as BuiltinToolContext["scenarioHostStateStore"];
  const pending = f.execute({ availableToolNames: ["switch_session_mode"] })("switch_session_mode", { modeId: "scenario_host" });
  assert.equal(f.sessionManager.getModeId(f.sessionId), "scenario_host");
  const draft = startSkillDraft(f.config, f.sessionId, "test-guide");
  f.sessionManager.setOperationMode(f.sessionId, { kind: "skill_config", skillId: draft.id });
  release();
  await assert.rejects(pending, /技能配置草稿/);
  assert.deepEqual(readSkillDraft(f.config, f.sessionId), draft);
  assert.equal(f.sessionManager.getOperationMode(f.sessionId).kind, "skill_config");
  assert.equal(characterRepository(f.config.dataDir).draft(f.sessionId), null);
});
