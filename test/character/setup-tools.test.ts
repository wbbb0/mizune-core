import { setupEditBindings, stageSetupBindings } from "../../src/character/setupEditing.ts";
import { getCharacterSection } from "../../src/character/schemaCatalog.ts";
import { listTurnToolsets } from "../../src/llm/tools/toolsetSelectionPolicy.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { characterRepository } from "../../src/character/repository.ts";
import { getBuiltinTools, createBuiltinToolExecutor } from "../../src/llm/tools/index.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { jsonStringErrors } from "../../src/llm/tools/setup/inputValidation.ts";
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
  const availableToolNames = ["list_character_sections", "read_character_section", "edit_character_section"];
  const call = async (name: string, args: unknown, allowed = availableToolNames) => {
    const execute = createBuiltinToolExecutor(ctx, { availableToolNames: allowed, expectedCharacterDraftId: draft.id });
    const result = await execute({ id: "test", type: "function", function: { name, arguments: JSON.stringify(args) } }, args);
    return JSON.parse(typeof result === "string" ? result : result.content);
  };
  let sectionId = stage === "persona" ? "persona.name" : "social.identity";
  const read = (id: string) => { sectionId = id; return call("read_character_section", { id }); };
  const tools = () => getBuiltinTools("owner", null, config, { availableToolNames, visibilityContext: { sessionId: "s" } });
  const tool = (action: string) => tools().find(tool => tool.function.name === setupEditBindings(getCharacterSection(sectionId), draft.id).find(binding => binding.action === action)!.definition.function.name)!.function;
  const edit = (args: unknown, action = "fill") => call(tool(action).name, args);
  return { store, draft, ctx, call, read, edit, tools, tool };
}

test("名称直接填写业务字段，不再有 value/action/id/draftId 参数", async () => {
  const f = fixture("persona");
  assert.equal(f.tools().some(tool => tool.function.name.startsWith("setup_")), true);
  const schema: any = f.tool("fill").parameters;
  assert.deepEqual(Object.keys(schema.properties), ["name"]);
  assert.deepEqual(schema.required, ["name"]);
  assert.ok(f.tool("fill").name.length <= 64);
  assert.equal((await f.edit({ name: "小满" })).saved, true);
  assert.equal(f.store.draft("s")!.value.persona.name, "小满");
  const result = await f.edit({ name: '{"name":"不应保存"}' });
  assert.equal(result.code, "setup_input_invalid");
  assert.equal(result.issues[0].path, "/name");
  assert.equal(f.store.draft("s")!.value.persona.name, "小满");
  assert.equal((await f.edit({ value: "小满" })).saved, false);
});

test("身份对象顶层局部修改、数组直接赋值、跳过不清空，回执不回显整份档案", async () => {
  const f = fixture(); await f.read("social.identity");
  const schema: any = f.tool("fill").parameters;
  assert.ok(schema.properties.occupation); assert.equal(schema.properties.value, undefined);
  const result = await f.edit({ occupation: "歌手", species: "人类", socialRoles: ["主唱"] });
  assert.equal(result.saved, true); assert.equal(result.value, undefined);
  assert.deepEqual(result.changedFields, ["occupation", "species", "socialRoles"]);
  assert.equal((await f.edit({ occupation: "学生" })).saved, true);
  const before = f.store.draft("s")!.value.social.identity;
  assert.equal(before.species, "人类");
  assert.equal((await f.edit({}, "skip")).saved, true);
  assert.deepEqual(f.store.draft("s")!.value.social.identity, before);
  assert.equal((await f.edit({ occupation: null })).saved, true);
  assert.equal(f.store.draft("s")!.value.social.identity.occupation, null);
  assert.equal((await f.edit({ invalid: "x" })).saved, false);
  assert.equal((await f.edit({ socialRoles: '["主唱"]' })).saved, false);
  assert.equal((await f.edit({ socialRoles: ['{"role":"主唱"}'] })).saved, false);
  assert.equal((await f.edit({})).saved, false);
});

test("递归拒绝纯 JSON 对象/数组字符串和代码块，不误伤数字、原子 JSON 或普通叙述", () => {
  for (const value of [' {"name":"小满"} ', '["a"]', '```json\n{"name":"小满"}\n```', '```\n[]\n```']) {
    const errors = jsonStringErrors({ items: [{ name: value }] });
    assert.equal(errors[0]?.path, "/items/0/name", value);
  }
  for (const value of ["21", "true", "null", '"文本"', '说明示例：{"name":"小满"}', "{不是JSON}", "普通文本"]) assert.deepEqual(jsonStringErrors(value), [], value);
  assert.deepEqual(jsonStringErrors({ name: "小满", age: 21, data: [true, null] }), []);
  assert.equal(jsonStringErrors({ "a/b~c": "[]" })[0]?.path, "/a~1b~0c");
});

test("读取不切换工具，取消重建及确认换阶段拒绝旧轮次写入，权限不变", async () => {
  const f = fixture(); await f.read("social.identity");
  const oldTool = f.tool("fill").name;
  await f.read("social.background");
  assert.equal((await f.call(oldTool, { occupation: "x" })).saved, true);
  await f.read("social.identity");
  f.ctx.relationship = "known";
  assert.match((await f.call(oldTool, { occupation: "x" })).error, /owner/);
  f.ctx.relationship = "owner";
  assert.ok((await f.call(oldTool, { occupation: "x" }, ["read_character_section"])).error);
  f.store.cancel("s"); f.store.ensureSetup("s", "stateful_rp"); await f.read("social.identity");
  assert.equal(f.tool("fill").name, oldTool);
  assert.equal((await f.call(oldTool, { occupation: "x" })).code, "stale_setup_tool");
  const second = f.tool("fill").name;
  f.store.confirm("s", "stateful_rp"); f.store.ensureSetup("s", "stateful_rp");
  assert.equal((await f.call(second, { occupation: "x" })).code, "stale_setup_tool");
  assert.equal((await f.call("edit_character_section", { id: "social.identity", value: {}, action: "set" })).code, "setup_requires_bound_tool");
});

test("衣柜新增、更新、删除使用独立工具，ID 不混入业务字段", async () => {
  const f = fixture("embodiment"), id = "embodiment.wardrobe.items";
  await f.read(id);
  assert.equal((f.tool("add").parameters as any).properties.id, undefined);
  const result = await f.edit({ name: "外套" }, "add");
  assert.equal(result.saved, true, JSON.stringify(result)); assert.ok(result.itemId);
  const itemId = result.itemId;
  assert.equal((await f.edit({ itemId, name: "短外套" }, "update")).saved, true);
  const items = f.store.draft("s")!.value.embodiment.wardrobe.items;
  assert.equal(items.length, 1); assert.equal(items[0].name, "短外套");
  assert.equal((await f.edit({ itemId: "missing", name: "x" }, "update")).saved, false);
  assert.equal((await f.edit({}, "remove")).saved, false);
  assert.equal((await f.edit({ itemId }, "remove")).saved, true);
  assert.deepEqual(f.store.draft("s")!.value.embodiment.wardrobe.items, []);
});

test("状态初始化隐藏代码字段，可空对象通过明确清空工具置空", async () => {
  const f = fixture("state"); await f.read("session.simulation.clock");
  const schema: any = f.tool("fill").parameters;
  assert.equal(schema.properties.minutesSinceLastMindTick, undefined);
  assert.equal((await f.edit({ minutesSinceLastMindTick: 100 })).saved, false);
  assert.equal((await f.edit({ currentIso: "2026-01-01T00:00:00Z" })).saved, true);
  assert.equal((await f.edit({}, "clear")).saved, true);
  assert.equal(f.store.draft("s")!.value.simulation.clock, null);
});

test("相同失败调用被拦截，修正后能继续；普通游玩仍使用原接口", async () => {
  const f = fixture("persona"); await f.read("persona.name");
  assert.equal((await f.edit({ name: '{"name":"小满"}' })).code, "setup_input_invalid");
  assert.equal((await f.edit({ name: '{"name":"小满"}' })).repeated, true);
  assert.equal((await f.edit({ name: "小满" })).saved, true);
  f.store.cancel("s");
  const definition = f.tools().find(tool => tool.function.name === "edit_character_section")!;
  assert.deepEqual((definition.function.parameters as any).properties.action.enum, ["set", "upsert", "remove", "skip"]);
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

test("Scenario 初始化执行器校验枚举/未知字段并拒绝编码对象，普通模式不受影响", async () => {
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
  assert.equal((await run({ mechanics: '{"dicePolicy":"公开掷骰"}', flags: '{"ready":true}' })).code, "setup_input_invalid");
  assert.equal(writes, 0);
  await run({ mechanics: { dicePolicy: "公开掷骰" }, flags: { ready: true } });
  assert.equal(state.mechanics.dicePolicy, "公开掷骰"); assert.equal(state.flags.ready, true);
  operation = { kind: "normal" };
  await run({ mechanics: '{"dicePolicy":"不应应用"}' });
  assert.equal(state.mechanics.dicePolicy, "公开掷骰");
});




test("真实工具目录直接暴露稳定名字工具，无需先读取", async () => {
  const f = fixture("persona");
  const input = { config: f.ctx.config, relationship: "owner" as const, currentUser: null,
    modelRef: [] as string[], includeDebugTools: false, visibilityContext: { sessionId: "s" },
    setupPhase: { setupToolsetOverrides: [{ toolsetId: "memory_profile", title: "角色配置", description: "角色配置", plannerSignals: [], toolNames: ["list_character_sections", "read_character_section", "edit_character_section"] }] }
  };
  const allowed = listTurnToolsets(input).flatMap(toolset => toolset.toolNames);
  assert.ok(allowed.includes("setup_fill_persona_name"));
  assert.ok(!allowed.includes("edit_character_section"));
  const tools = getBuiltinTools("owner", null, f.ctx.config, { availableToolNames: allowed, visibilityContext: { sessionId: "s" } });
  const fill = tools.find(tool => tool.function.name.startsWith("setup_fill_"))!;
  assert.ok(fill);
  assert.equal((await f.call(fill.function.name, { name: "小满" }, allowed)).saved, true);
  assert.ok(listTurnToolsets(input).flatMap(toolset => toolset.toolNames).includes("setup_fill_persona_name"));
});


test("参与者与穿戴引用不自动生成随机 ID", async () => {
  const f = fixture("state");
  await f.read("session.social.participantRelationships");
  assert.ok((f.tool("add").parameters as any).required.includes("participantId"));
  assert.equal((await f.edit({ displayName: "玩家" }, "add")).saved, false);
  const added = await f.edit({ participantId: "owner", displayName: "玩家" }, "add");
  assert.equal(added.saved, true); assert.equal(added.itemId, "owner");
  assert.equal(f.store.draft("s")!.value.social.participantRelationships[0].participantId, "owner");
  assert.equal((await f.edit({ participantId: "owner", displayName: "重复" }, "add")).saved, false);
  await f.read("session.simulation.wardrobe.worn");
  assert.ok((f.tool("add").parameters as any).required.includes("instanceId"));
  assert.equal((await f.edit({ wearingWay: "normal" }, "add")).saved, false);
});


test("分组按需开放且执行不能越过未加载的组", async () => {
  const f = fixture("social");
  const groups = listTurnToolsets({
    config: f.ctx.config, relationship: "owner", currentUser: null,
    modelRef: [], includeDebugTools: false, visibilityContext: { sessionId: "s" },
    setupPhase: { setupToolsetOverrides: [{ toolsetId: "memory_profile", toolNames: ["list_character_sections", "read_character_section", "edit_character_section"] }] }
  });
  const identity = groups.find(group => group.id === "character_setup_social_identity")!;
  const background = groups.find(group => group.id === "character_setup_social_background")!;
  assert.ok(identity && background);
  const allowed = identity.toolNames;
  const projected = getBuiltinTools("owner", null, f.ctx.config, { availableToolNames: allowed, visibilityContext: { sessionId: "s" } });
  assert.deepEqual(projected.map(tool => tool.function.name).sort(), [...allowed].sort());
  assert.equal((await f.call("setup_fill_social_identity", { occupation: "学生" }, allowed)).saved, true);
  assert.ok((await f.call(background.toolNames[0]!, {}, allowed)).error);
  await f.read("social.background");
  assert.equal((await f.call("setup_fill_social_identity", { occupation: "教师" }, allowed)).saved, true);
});

test("所有阶段工具名称稳定、唯一并符合长度限制", () => {
  for (const stage of ["persona", "social", "embodiment", "state"]) {
    const names = stageSetupBindings(stage, "draft-a").map(binding => binding.definition.function.name);
    assert.deepEqual(names, stageSetupBindings(stage, "draft-b").map(binding => binding.definition.function.name));
    assert.equal(new Set(names).size, names.length);
    for (const name of names) assert.ok(name.length <= 64 && /^[a-zA-Z0-9_]+$/.test(name), name);
  }
});
