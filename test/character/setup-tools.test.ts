import { setupEditBindings, stageSetupBindings } from "../../src/character/setupEditing.ts";
import { getCharacterSection } from "../../src/character/schemaCatalog.ts";
import { listTurnToolsets } from "../../src/llm/tools/toolsetSelectionPolicy.ts";
import { resolveSessionBoundaryToolNames } from "../../src/llm/tools/toolsetBoundary.ts";
import { characterToolNames } from "../../src/character/tools.ts";
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
  const config = createTestAppConfig({
    llm: {
      enabled: true,
      providers: {
        vision: {
          type: "openai_compatible",
          baseUrl: "https://example.com/v1",
          apiKey: "test-key",
          proxy: false
        }
      },
      models: {
        visual: {
          provider: "vision",
          model: "visual-model",
          chat: {
            capabilities: { supportsThinking: false, supportsVision: true, supportsAudioInput: false, supportsTools: true, supportsSearch: false },
            preserveThinking: false
          }
        }
      },
      routingPresets: {
        test: {
          mainSmall: ["visual"],
          mainLarge: ["visual"],
          summarizer: ["visual"],
          sessionCaptioner: ["visual"],
          imageCaptioner: ["visual"],
          imageInspector: ["visual"],
          audioTranscription: ["visual"],
          turnPlanner: ["visual"]
        }
      },
      imageInspector: {
        enabled: true,
        timeoutMs: 5000,
        enableThinking: false,
        maxConcurrency: 2
      }
    }
  }), store = characterRepository(config.dataDir);
  if (stage !== "persona") { store.begin("s", "persona", "setup", "stateful_rp"); store.confirm("s", "stateful_rp"); }
  if (stage === "embodiment" || stage === "state") { store.begin("s", "social", "setup", "stateful_rp"); store.confirm("s", "stateful_rp"); }
  if (stage === "state") { store.begin("s", "embodiment", "setup", "stateful_rp"); store.confirm("s", "stateful_rp"); }
  const draft = store.ensureSetup("s", "stateful_rp")!;
  const files = new Map<string, any>([
    ["cf_ref_1", { fileId: "cf_ref_1", fileRef: "upload_ref_1.png", kind: "image", available: true }],
    ["cf_ref_2", { fileId: "cf_ref_2", fileRef: "upload_ref_2.png", kind: "image", available: true }],
    ["cf_gif_1", { fileId: "cf_gif_1", fileRef: "upload_gif_1.gif", kind: "animated_image", available: true }],
    ["cf_missing_disk", { fileId: "cf_missing_disk", fileRef: "upload_missing.png", kind: "image", available: false }]
  ]);
  for (let i = 1; i <= 10; i++) {
    files.set(`cf_cap_${i}`, { fileId: `cf_cap_${i}`, fileRef: `upload_cap_${i}.png`, kind: "image", available: true });
  }
  const retainedFileCounts = new Map<string, number>();
  const chatFileStore = {
    async getFile(id: string) {
      return files.get(id) ?? null;
    },
    async listFiles() {
      return [...files.values()];
    },
    async resolveSelector(selector: string) {
      return files.get(selector) ?? [...files.values()].find(file => file.fileRef === selector) ?? null;
    },
    async isFileAvailable(id: string) {
      return Boolean(files.get(id)?.available);
    },
    async withRetainedFiles<T>(ids: Iterable<string>, op: () => Promise<T> | T) {
      const acquired = [...new Set(ids)];
      for (const id of acquired) retainedFileCounts.set(id, (retainedFileCounts.get(id) ?? 0) + 1);
      try {
        return await op();
      } finally {
        for (const id of acquired) {
          const count = (retainedFileCounts.get(id) ?? 1) - 1;
          if (count === 0) retainedFileCounts.delete(id);
          else retainedFileCounts.set(id, count);
        }
      }
    },
    listRetainedFileIds() {
      return new Set(retainedFileCounts.keys());
    }
  };
  let inspectionCallCount = 0;
  let nextInspectionItem: any = {
    mediaId: "cf_ref_1",
    status: "answered",
    found: true,
    answer: "1. 【整体轮廓与构图】：单人全身立绘。\n2. 【头发与头部装饰】：银白长发，蓝丝带。",
    visibleContentSummary: "银发少女全身立绘",
    nearMatches: [],
    confidenceNotes: [],
    rawAnswer: "{}",
    parseStatus: "parsed",
    schemaIssues: [],
    modelRef: "visual",
    completionStatus: "completed"
  };
  let onDuringInspection: (() => void) | null = null;
  const mediaVisionService = {
    async prepareFileForModel(fileId: string) {
      return {
        inputUrl: `data:image/png;base64,${fileId}`,
        kind: "image",
        animated: false,
        durationMs: null,
        sampledFrameCount: null
      };
    }
  };
  const mediaInspectionService = {
    isEnabled() {
      return config.llm.imageInspector.enabled;
    },
    async inspectPreparedMedia(input: { question: string; media: Array<{ mediaId: string }> }) {
      inspectionCallCount += 1;
      onDuringInspection?.();
      const item = typeof nextInspectionItem === "function" ? nextInspectionItem(input) : nextInspectionItem;
      return {
        ok: item.status !== "error",
        requestedCount: input.media.length,
        results: [{ ...item, mediaId: input.media[0]?.mediaId ?? item.mediaId }]
      };
    }
  };
  const ctx = {
    config,
    relationship: "owner",
    currentUser: null,
    lastMessage: { sessionId: "s" },
    chatFileStore,
    mediaVisionService,
    mediaInspectionService,
    sessionManager: {
      getSession: () => ({ id: "s", modeId: "stateful_rp", toolsetPreferences: { overrides: {} } }),
      getOperationMode: () => ({ kind: "character_config", stage: draft.stage })
    }
  } as unknown as BuiltinToolContext;
  const availableToolNames = [...characterToolNames];
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
  return {
    store,
    draft,
    ctx,
    files,
    call,
    read,
    edit,
    tools,
    tool,
    getInspectionCallCount: () => inspectionCallCount,
    setNextInspectionItem: (item: any) => { nextInspectionItem = item; },
    setOnDuringInspection: (fn: (() => void) | null) => { onDuringInspection = fn; }
  };
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
    getOperationMode: () => operation, getModeId: () => "scenario_host", getSession: () => ({ id: "s", type: "private", modeId: "scenario_host", toolsetPreferences: { overrides: {} }, participantRef: { kind: "user", id: "owner" } })
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


test("当前阶段全部工具直接开放，显式工具白名单仍有效", async () => {
  const f = fixture("social");
  const groups = listTurnToolsets({
    config: f.ctx.config, relationship: "owner", currentUser: null,
    modelRef: [], includeDebugTools: false, visibilityContext: { sessionId: "s" },
    setupPhase: { setupToolsetOverrides: [{ toolsetId: "memory_profile", toolNames: ["list_character_sections", "read_character_section", "edit_character_section"] }] }
  });
  const allNames = groups.flatMap(group => group.toolNames);
  assert.ok(allNames.includes("setup_fill_social_identity"));
  assert.ok(allNames.includes("setup_fill_social_background"));
  const allowed = ["setup_fill_social_identity"];
  const projected = getBuiltinTools("owner", null, f.ctx.config, { availableToolNames: allowed, visibilityContext: { sessionId: "s" } });
  assert.deepEqual(projected.map(tool => tool.function.name).sort(), [...allowed].sort());
  assert.equal((await f.call("setup_fill_social_identity", { occupation: "学生" }, allowed)).saved, true);
  assert.ok((await f.call("setup_fill_social_background", {}, allowed)).error);
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

test("social.referenceImages 专用修改工具隐藏 fileId 与 subject，embodiment 阶段可按 itemId 只读读取参考图且不暴露编辑工具", async () => {
  const f = fixture("social");
  const refSection = await f.read("social.referenceImages");
  assert.equal(refSection.writable, true);
  const addParams = f.tool("add").parameters as any;
  const updateParams = f.tool("update").parameters as any;
  assert.ok(addParams.properties.fileId);
  assert.ok(addParams.required.includes("fileId"));
  assert.equal(updateParams.properties.fileId, undefined);
  assert.equal(updateParams.properties.subject, undefined);
  assert.ok(updateParams.properties.label);
  assert.ok(updateParams.properties.description);

  const added = await f.edit({ fileId: "cf_ref_1", label: "常服立绘", subject: "  小满 ", description: "白衬衫与百褶裙" }, "add");
  assert.equal(added.saved, true);
  assert.ok(added.itemId);

  // update 工具拒绝传入不可变字段 fileId / subject，允许修改 label / description
  assert.equal((await f.edit({ itemId: added.itemId, fileId: "cf_other", label: "篡改" }, "update")).code, "setup_input_invalid");
  assert.equal((await f.edit({ itemId: added.itemId, subject: "其他主体", label: "篡改" }, "update")).code, "setup_input_invalid");
  const updated = await f.edit({ itemId: added.itemId, label: "校服立绘" }, "update");
  assert.equal(updated.saved, true);

  f.store.confirm("s", "stateful_rp");
  f.store.ensureSetup("s", "stateful_rp"); // 进入 embodiment 阶段

  const listResult = await f.call("list_character_sections", {});
  const listedRef = listResult.sections.find((s: any) => s.id === "social.referenceImages");
  assert.ok(listedRef);
  assert.equal(listedRef.writable, false);
  assert.match(listedRef.nextStep, /只读/);

  const readAllInEmbodiment = await f.call("read_character_section", { id: "social.referenceImages" });
  assert.equal(readAllInEmbodiment.writable, false);
  assert.equal(readAllInEmbodiment.editTools, undefined);
  assert.equal(readAllInEmbodiment.value.length, 1);

  const readSingleInEmbodiment = await f.call("read_character_section", { id: "social.referenceImages", itemId: added.itemId });
  assert.equal(readSingleInEmbodiment.writable, false);
  assert.equal(readSingleInEmbodiment.editTools, undefined);
  assert.equal(readSingleInEmbodiment.itemId, added.itemId);
  assert.equal(readSingleInEmbodiment.value.label, "校服立绘");
  assert.equal(readSingleInEmbodiment.value.subject, "小满");
});

test("import_character_reference 暴露边界、character_config 工具集选择与单人/多人/重复导入/刷新/容量/截断/并发保护", async () => {
  const fPersona = fixture("persona");
  assert.equal(fPersona.tools().some(t => t.function.name === "import_character_reference"), false);

  const fSocial = fixture("social");
  assert.equal(fSocial.tools().some(t => t.function.name === "import_character_reference"), true);
  assert.equal(
    getBuiltinTools("known", null, fSocial.ctx.config, { visibilityContext: { sessionId: "s" } })
      .some(t => t.function.name === "import_character_reference"),
    false
  );

  // resolveSessionBoundaryToolNames 与 listTurnToolsets 在 character_config 阶段放行角色工具与 availableDuringSetup 工具集
  const boundary = resolveSessionBoundaryToolNames("stateful_rp", { overrides: {} }, { kind: "character_config", stage: "social" });
  assert.equal(boundary.has("import_character_reference"), true);
  assert.equal(boundary.has("asset_send_to_chat"), true);
  assert.equal(boundary.has("generate_image"), true);
  const disabledBoundary = resolveSessionBoundaryToolNames(
    "stateful_rp",
    { overrides: { asset_io: "disabled", image_generation: "disabled" } },
    { kind: "character_config", stage: "social" }
  );
  assert.equal(disabledBoundary.has("import_character_reference"), true);
  assert.equal(disabledBoundary.has("asset_send_to_chat"), false);
  assert.equal(disabledBoundary.has("generate_image"), false);

  const turnToolsets = listTurnToolsets({
    config: fSocial.ctx.config,
    relationship: "owner",
    currentUser: null,
    modelRef: ["visual"],
    includeDebugTools: false,
    modeId: "stateful_rp",
    operationMode: { kind: "character_config", stage: "social" },
    visibilityContext: { sessionId: "s" }
  });
  const turnToolNames = turnToolsets.flatMap(ts => ts.toolNames);
  assert.ok(turnToolNames.includes("import_character_reference"));

  // 1. 单人图按 asset_ref 导入（自动归一化为规范 file_id，缺省 label 为“角色设定图”）
  const imported1 = await fSocial.call("import_character_reference", { asset_ref: "upload_ref_1.png" });
  assert.equal(imported1.ok, true);
  assert.equal(imported1.reused, false);
  assert.equal(imported1.draftOnly, true);
  assert.equal(imported1.fileId, "cf_ref_1");
  assert.equal(imported1.label, "角色设定图");
  assert.equal(imported1.subject, null);
  assert.equal(fSocial.getInspectionCallCount(), 1);

  // 2. 默认重复导入不重复调用模型，也不覆盖人工修正的标签/描述
  await fSocial.read("social.referenceImages");
  await fSocial.edit({ itemId: imported1.itemId, label: "人工修正标签", description: "人工修正描述" }, "update");
  const reused = await fSocial.call("import_character_reference", { asset_ref: "cf_ref_1", label: "新标签不生效" });
  assert.equal(reused.ok, true);
  assert.equal(reused.reused, true);
  assert.equal(reused.label, "人工修正标签");
  assert.equal(reused.description, "人工修正描述");
  assert.equal(fSocial.getInspectionCallCount(), 1);

  // 3. 同一张多人图按不同 subject 建立独立条目（subject 去除首尾空白）
  fSocial.setNextInspectionItem((input: { question: string }) => {
    assert.match(input.question, /右侧黑发角色/);
    return {
      mediaId: "cf_ref_1",
      status: "answered",
      found: true,
      answer: "右侧黑发高马尾少女描述",
      visibleContentSummary: "双人立绘",
      nearMatches: [],
      confidenceNotes: ["披风背面被遮挡"],
      rawAnswer: "{}",
      parseStatus: "parsed",
      schemaIssues: [],
      modelRef: "visual",
      completionStatus: "unknown"
    };
  });
  const importedSubject = await fSocial.call("import_character_reference", {
    asset_ref: "cf_ref_1",
    subject: "  右侧黑发角色  "
  });
  assert.equal(importedSubject.ok, true);
  assert.equal(importedSubject.reused, false);
  assert.equal(importedSubject.subject, "右侧黑发角色");
  assert.equal(importedSubject.label, "右侧黑发角色");
  assert.equal(importedSubject.completionStatus, "unknown");
  assert.match(importedSubject.completionNote, /completionStatus=unknown/);
  assert.equal(fSocial.getInspectionCallCount(), 2);

  // 4. 拒绝 repaired / truncated / uncertain / not_found / 非静态图片 / 丢失磁盘文件，不写入半成品
  const badAsset = await fSocial.call("import_character_reference", { asset_ref: "cf_gif_1" });
  assert.equal(badAsset.ok, false);
  assert.equal(badAsset.code, "setup_edit_rejected");

  const missingDisk = await fSocial.call("import_character_reference", { asset_ref: "cf_missing_disk" });
  assert.equal(missingDisk.ok, false);
  assert.equal(missingDisk.code, "setup_edit_rejected");

  for (const rejectedCase of [
    { parseStatus: "repaired" as const, completionStatus: "completed" as const, status: "answered" as const, found: true, expectedCode: "inspection_incomplete" },
    { parseStatus: "parsed" as const, completionStatus: "truncated" as const, status: "answered" as const, found: true, expectedCode: "inspection_incomplete" },
    { parseStatus: "parsed" as const, completionStatus: "completed" as const, status: "uncertain" as const, found: null, expectedCode: "inspection_uncertain" },
    { parseStatus: "parsed" as const, completionStatus: "completed" as const, status: "not_found" as const, found: false, expectedCode: "inspection_target_not_found" }
  ]) {
    fSocial.setNextInspectionItem({
      mediaId: "cf_ref_2",
      status: rejectedCase.status,
      found: rejectedCase.found,
      answer: "候选或残缺文本",
      visibleContentSummary: "画面摘要",
      nearMatches: ["左侧角色", "右侧角色"],
      confidenceNotes: [],
      rawAnswer: "{}",
      parseStatus: rejectedCase.parseStatus,
      schemaIssues: [],
      modelRef: "visual",
      completionStatus: rejectedCase.completionStatus
    });
    const failed = await fSocial.call("import_character_reference", { asset_ref: "cf_ref_2" });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, rejectedCase.expectedCode);
  }
  assert.equal((await fSocial.read("social.referenceImages")).value.length, 2);

  // 5. refresh: true 在条目未被并发修改时成功刷新，若精读期间条目被修改则拒绝覆盖
  fSocial.setNextInspectionItem({
    mediaId: "cf_ref_1",
    status: "answered",
    found: true,
    answer: "刷新后的全新视觉描述",
    visibleContentSummary: "立绘",
    nearMatches: [],
    confidenceNotes: [],
    rawAnswer: "{}",
    parseStatus: "parsed",
    schemaIssues: [],
    modelRef: "visual",
    completionStatus: "completed"
  });
  fSocial.setOnDuringInspection(() => {
    const d = fSocial.store.draft("s")!;
    d.value.social.referenceImages[0].description = "精读期间并发修改";
    fSocial.store.edit("s", "stateful_rp", "social.referenceImages", "upsert", d.value.social.referenceImages[0], imported1.itemId, d.id);
  });
  const conflictRefresh = await fSocial.call("import_character_reference", {
    asset_ref: "cf_ref_1",
    refresh: true
  });
  assert.equal(conflictRefresh.ok, false);
  assert.match(conflictRefresh.error, /并发修改/);
  fSocial.setOnDuringInspection(null);

  const okRefresh = await fSocial.call("import_character_reference", {
    asset_ref: "cf_ref_1",
    label: "刷新后标签",
    refresh: true
  });
  assert.equal(okRefresh.ok, true);
  assert.equal(okRefresh.refreshed, true);
  assert.equal(okRefresh.label, "刷新后标签");
  assert.equal(okRefresh.description, "刷新后的全新视觉描述");

  // 6. 满 8 张容量上限时在调用精读模型前直接拦截
  for (let i = 3; i <= 8; i++) {
    const res = await fSocial.call("import_character_reference", { asset_ref: `cf_cap_${i}` });
    assert.equal(res.ok, true);
  }
  const callsBeforeCapLimit = fSocial.getInspectionCallCount();
  const capExceeded = await fSocial.call("import_character_reference", { asset_ref: "cf_cap_9" });
  assert.equal(capExceeded.ok, false);
  assert.match(capExceeded.error, /上限/);
  assert.equal(fSocial.getInspectionCallCount(), callsBeforeCapLimit);

  // 7. 执行端校验会话模式层级（tierForMode >= 2）与 operationMode（kind === "character_config"）
  const assistantCtx = {
    ...fSocial.ctx,
    sessionManager: {
      ...fSocial.ctx.sessionManager,
      getSession: () => ({ id: "s", modeId: "assistant", toolsetPreferences: { overrides: {} } }) as any
    }
  };
  const rejectedByModeRaw = await createBuiltinToolExecutor(assistantCtx, {
    availableToolNames: [...characterToolNames],
    expectedCharacterDraftId: fSocial.draft.id
  })(
    { id: "c", type: "function", function: { name: "import_character_reference", arguments: JSON.stringify({ asset_ref: "cf_ref_1" }) } },
    { asset_ref: "cf_ref_1" }
  );
  const rejectedByMode = JSON.parse(typeof rejectedByModeRaw === "string" ? rejectedByModeRaw : rejectedByModeRaw.content);
  assert.equal(rejectedByMode.ok, false);
  assert.equal(rejectedByMode.code, "setup_edit_rejected");

  const nonConfigOpCtx = {
    ...fSocial.ctx,
    sessionManager: {
      ...fSocial.ctx.sessionManager,
      getOperationMode: () => ({ kind: "normal" }) as any
    }
  };
  const rejectedByOpModeRaw = await createBuiltinToolExecutor(nonConfigOpCtx, {
    availableToolNames: [...characterToolNames],
    expectedCharacterDraftId: fSocial.draft.id
  })(
    { id: "c", type: "function", function: { name: "import_character_reference", arguments: JSON.stringify({ asset_ref: "cf_ref_1" }) } },
    { asset_ref: "cf_ref_1" }
  );
  const rejectedByOpMode = JSON.parse(typeof rejectedByOpModeRaw === "string" ? rejectedByOpModeRaw : rejectedByOpModeRaw.content);
  assert.equal(rejectedByOpMode.ok, false);
  assert.equal(rejectedByOpMode.code, "setup_edit_rejected");
});
