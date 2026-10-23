import test from "node:test";
import assert from "node:assert/strict";
import { characterToolHandlers } from "../../src/character/tools.ts";
import { characterRepository } from "../../src/character/repository.ts";
import { getBuiltinTools, createBuiltinToolExecutor } from "../../src/llm/tools/index.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { normalizeSetupContainers } from "../../src/llm/tools/setup/inputValidation.ts";
import { createScenarioHostSetupToolsetOverrides } from "../../src/modes/scenarioHost/setupToolsets.ts";
import { getBuiltinToolDescriptorByName } from "../../src/llm/tools/toolRegistry.ts";
import { initializationToolDefinition } from "../../src/llm/tools/setup/initializationContracts.ts";
import type { BuiltinToolContext } from "../../src/llm/tools/core/shared.ts";

function fixture(stage = "social") {
  const config = createTestAppConfig(), store = characterRepository(config.dataDir);
  if (stage !== "persona") { store.begin("s", "persona", "setup", "stateful_rp"); store.confirm("s", "stateful_rp"); }
  if (stage === "embodiment" || stage === "state") { store.begin("s", "social", "setup", "stateful_rp"); store.confirm("s", "stateful_rp"); }
  if (stage === "state") { store.begin("s", "embodiment", "setup", "stateful_rp"); store.confirm("s", "stateful_rp"); }
  const draft = store.ensureSetup("s", "stateful_rp")!;
  const ctx = { config, relationship: "owner", currentUser: null, lastMessage: { sessionId: "s" },
    sessionManager: { getSession: () => ({ modeId: "stateful_rp" }), getOperationMode: () => ({ kind: "character_config", stage: draft.stage }) }
  } as unknown as BuiltinToolContext;
  const call = async (name: string, args: unknown) => JSON.parse(String(await characterToolHandlers[name]!({ id: "test", type: "function", function: { name, arguments: JSON.stringify(args) } }, args, ctx)));
  const read = (id: string) => call("read_character_section", { id });
  const edit = (id: string, value: unknown, other = {}) => call("edit_character_section", { draftId: draft.id, id, value, ...other });
  const tools = () => getBuiltinTools("owner", null, config, { availableToolNames: ["list_character_sections", "read_character_section", "edit_character_section"], visibilityContext: { sessionId: "s" } });
  return { store, draft, ctx, call, read, edit, tools };
}

test("读取当前块后仅暴露该块的强类型局部编辑格式", async () => {
  const f = fixture();
  assert.equal(f.tools().some(tool => tool.function.name === "edit_character_section"), false);
  const result = await f.read("social.identity");
  assert.equal(result.draftId, f.draft.id);
  const schema: any = f.tools().find(tool => tool.function.name === "edit_character_section")!.function.parameters;
  assert.deepEqual(schema.properties.id.enum, ["social.identity"]);
  assert.equal(schema.properties.value.type, "object");
  assert.ok(schema.properties.value.properties.occupation);
  assert.equal(schema.properties.value.required, undefined);
  assert.deepEqual(schema.properties.action.enum, ["save", "skip"]);
  const rejected = await f.edit("social.identity", '{"occupation":"歌手"}', { action: "upsert" });
  assert.equal(rejected.code, "setup_input_invalid");
  assert.match(JSON.stringify(rejected.issues), /save/);
  assert.equal(f.store.draft("s")!.value.social.identity.occupation, null);
});

test("初始化接受一层对象编码并局部合并，文本保持原文，skip 不清空", async () => {
  const f = fixture(); await f.read("social.identity");
  assert.equal((await f.edit("social.identity", '{"occupation":"歌手","species":"人类"}')).saved, true);
  assert.equal((await f.edit("social.identity", { occupation: "学生" })).saved, true);
  const before = f.store.draft("s")!.value.social.identity;
  assert.equal(before.species, "人类"); assert.equal(before.occupation, "学生");
  assert.equal((await f.call("edit_character_section", { id: "social.identity", draftId: f.draft.id, action: "skip" })).saved, true);
  assert.deepEqual(f.store.draft("s")!.value.social.identity, before);
  assert.equal((await f.edit("social.identity", { occupation: null })).saved, true);
  assert.equal(f.store.draft("s")!.value.social.identity.occupation, null);
  assert.equal((await f.edit("social.identity", { invalid: "x" })).saved, false);
  assert.equal((await f.edit("social.identity", { socialRoles: [7] })).saved, false);
  const text = '{"test":1}';
  assert.equal(normalizeSetupContainers(text, { type: "string" }), text);
});

test("换块、过期草稿、非 owner 均不能修改，普通游玩保留原接口", async () => {
  const f = fixture(); await f.read("social.identity"); await f.read("social.background");
  assert.equal((await f.edit("social.identity", { occupation: "x" })).code, "section_not_selected");
  await f.read("social.identity");
  f.ctx.relationship = "known";
  assert.match((await f.edit("social.identity", { occupation: "x" })).error, /owner/);
  f.ctx.relationship = "owner";
  f.store.confirm("s", "stateful_rp"); f.store.ensureSetup("s", "stateful_rp");
  assert.equal((await f.edit("social.identity", { occupation: "x" })).code, "stale_draft");
  assert.equal(f.tools().some(tool => tool.function.name === "edit_character_section"), false);
  f.store.cancel("s");
  const schema: any = f.tools().find(tool => tool.function.name === "edit_character_section")!.function.parameters;
  assert.deepEqual(schema.properties.action.enum, ["set", "upsert", "remove", "skip"]);
});

test("衣柜新增生成 ID、局部修改保留其他属性，删除必须显式指向现有条目", async () => {
  const f = fixture("embodiment"), id = "embodiment.wardrobe.items";
  await f.read(id);
  const result = await f.edit(id, { name: "外套" });
  assert.equal(result.saved, true, JSON.stringify(result));
  const itemId = result.value[0].id;
  assert.ok(itemId);
  const updated = await f.edit(id, { name: "短外套" }, { itemId });
  assert.equal(updated.value.length, 1); assert.equal(updated.value[0].name, "短外套");
  assert.equal((await f.edit(id, { name: "错误目标" }, { itemId: "missing" })).saved, false);
  assert.equal((await f.call("edit_character_section", { id, draftId: f.draft.id, action: "remove" })).saved, false);
  assert.equal((await f.call("edit_character_section", { id, draftId: f.draft.id, action: "remove", itemId })).saved, true);
  assert.deepEqual(f.store.draft("s")!.value.embodiment.wardrobe.items, []);
});

test("状态初始化工具不暴露代码字段，也拒绝直接传入", async () => {
  const f = fixture("state"), id = "session.simulation.clock";
  await f.read(id);
  const schema: any = f.tools().find(tool => tool.function.name === "edit_character_section")!.function.parameters;
  assert.equal(schema.properties.value.properties.minutesSinceLastMindTick, undefined);
  assert.equal((await f.edit(id, { minutesSinceLastMindTick: 100 })).saved, false);
  assert.equal((await f.edit(id, { currentIso: "2026-01-01T00:00:00Z" })).saved, true);
});

test("Scenario 初始化工具目录全部具有明确参数与纠错约定，普通模式不变", () => {
  for (const name of createScenarioHostSetupToolsetOverrides().flatMap(group => group.toolNames)) {
    const tool = getBuiltinToolDescriptorByName(name)!.definition;
    assert.equal(tool.function.parameters.type, "object", name);
    const configured = initializationToolDefinition(tool, undefined, undefined, { kind: "mode_setup", modeId: "scenario_host", draft: {} as never });
    assert.match(configured[0]!.function.description, /不要重复原参数/);
    assert.equal(initializationToolDefinition(tool, undefined, undefined, { kind: "normal" })[0], tool);
  }
});

test("Scenario 初始化执行器校验枚举/未知字段并解码嵌套对象，普通模式不自动解码", async () => {
  const config = createTestAppConfig(); let state: any = { flags: {}, mechanics: { ruleStyle: "freeform", dicePolicy: "", difficultyScale: "", successStates: [] } };
  let writes = 0; let operation: any = { kind: "mode_setup", modeId: "scenario_host", draft: {} };
  const context = { config, relationship: "owner", currentUser: null, lastMessage: { sessionId: "s" }, sessionManager: {
    getOperationMode: () => operation, getModeId: () => "scenario_host", getSession: () => ({ id: "s", type: "private", participantRef: { kind: "user", id: "owner" } })
  }, scenarioHostStateStore: { update: async (_id: string, updater: any) => { writes++; state = updater(state); return state; } } } as unknown as BuiltinToolContext;
  const execute = createBuiltinToolExecutor(context, { availableToolNames: ["update_scenario_state"] });
  const run = async (args: unknown) => {
    const result = await execute({ id: "x", type: "function", function: { name: "update_scenario_state", arguments: JSON.stringify(args) } }, args);
    return JSON.parse(typeof result === "string" ? result : result.content);
  };
  assert.equal((await run({ mechanics: { ruleStyle: "bad" } })).code, "setup_input_invalid");
  assert.equal((await run({ unexpected: true })).code, "setup_input_invalid"); assert.equal((await run({ flags: { nested: { ignored: true } } })).code, "setup_input_invalid"); assert.equal(writes, 0);
  await run({ mechanics: '{"dicePolicy":"公开掷骰"}', flags: '{"ready":true}' });
  assert.equal(state.mechanics.dicePolicy, "公开掷骰"); assert.equal(state.flags.ready, true);
  operation = { kind: "normal" };
  await run({ mechanics: '{"dicePolicy":"不应应用"}' });
  assert.equal(state.mechanics.dicePolicy, "公开掷骰");
});


test("初始化相同失败调用不会原样反复执行，读取或修正后可继续", async () => {
  const f = fixture();
  const execute = createBuiltinToolExecutor(f.ctx, { availableToolNames: ["read_character_section", "edit_character_section"] });
  const run = async (name: string, args: unknown) => {
    const result = await execute({ id: "x", type: "function", function: { name, arguments: JSON.stringify(args) } }, args);
    return JSON.parse(typeof result === "string" ? result : result.content);
  };
  await run("read_character_section", { id: "social.identity" });
  const bad = { id: "social.identity", draftId: f.draft.id, action: "upsert", value: '{"occupation":"歌手"}' };
  assert.equal((await run("edit_character_section", bad)).code, "setup_input_invalid");
  assert.equal((await run("edit_character_section", bad)).repeated, true);
  assert.equal((await run("edit_character_section", { ...bad, action: "save" })).saved, true);
  assert.equal((await run("edit_character_section", bad)).repeated, undefined);
  await run("read_character_section", { id: "social.identity" });
  assert.equal((await run("edit_character_section", bad)).repeated, undefined);
});
