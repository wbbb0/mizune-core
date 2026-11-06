import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { ref, reactive } from "vue";
import { llmCatalogFileSchema } from "#config/configModel.ts";
import { buildUiTree } from "#data/schema/ui.ts";

// 执行真实 composable，只替换窗口服务和资源客户端，保留 Vue 响应式草稿。
const source = readFileSync(new URL("../../../webui/src/composables/sections/useConfigSection.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const vueUrl = new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href;
const moduleSource = js.replace(/import[\s\S]*?from\s+["']([^"']+)["'];/g, (statement, name: string) => {
  if (name === "vue") return statement.replace('"vue"', JSON.stringify(vueUrl));
  if (name === "@/sections/config/modelTestActions" || name === "@/sections/config/modelAddSchema") return statement.replace(JSON.stringify(name), JSON.stringify(new URL(`../../../webui/src/sections/config/${name.split("/").at(-1)}.ts`, import.meta.url).href));
  return "";
});
const factory = await import(`data:text/javascript,${encodeURIComponent(`
let harness;
const createSharedSectionState = fn => fn;
const createResourceEditorState = () => harness.state;
const useWorkbenchWindows = () => harness.windows;
const useWorkbenchToasts = () => ({ push: value => harness.notifications.push(value) });
const editorApi = { validate: (...args) => harness.validate(...args) }, LlmModelAddWindow = {}, LlmModelTestWindow = {};
const window = { innerWidth: 1280, innerHeight: 800 };
const clearEditorMutations = () => {};
export function setup(value) { harness = value; return useConfigSection(); }
${moduleSource}`)}`);

function setup(models: Record<string, unknown> = {}) {
  let definition: any;
  const notifications: any[] = [], confirmations: any[] = [];
  let maximize: any, closed = false;
  const state = {
    selectedKey: ref("llm_catalog"), model: ref({ uiTree: buildUiTree(llmCatalogFileSchema), editorFeatures: {} }), loading: ref(false), saving: ref(false), validating: ref(false),
    draftValue: ref({ provider: { type: "openai_compatible", models } }),
    updateDraft(value: any) { state.draftValue.value = value; }
  };
  const dependencies = {
    state, notifications,
    validate: async (_key: string, value: unknown) => llmCatalogFileSchema.parseFromObject(value),
    windows: {
      setMaximized(_id: string, bounds: any) { maximize = bounds; },
      openSync(value: any) { definition = value; return { id: "test-window" }; },
      async openDialog(value: any): Promise<any> { confirmations.push(value); return { reason: "action", actionId: "confirm" }; },
      get() { return closed ? undefined : definition; },
      close() { closed = true; }
    }
  };
  const section = factory.setup(dependencies);
  const pending = section.beforeRecordMutation({ kind: "add", path: ["provider", "models"] });
  return { state, notifications, confirmations, dependencies, pending, maximize, props: () => definition.blocks[0].props(), get closed() { return closed; } };
}
const entry = { alias: "new_model", upstreamModel: "vendor/model", profile: { chat: { capabilities: { supportsTools: true } } } };

test("确认后连续添加模型并保持窗口，props 实时跟随草稿且保留期间编辑", async () => {
  const h = setup({ old: { upstreamModel: "old", chat: { defaults: reactive({ temperature: 0.5 }) } } });
  assert.equal(await h.pending, false);
  assert.equal(h.maximize.maximized, true);
  h.state.draftValue.value.provider.models.another = { upstreamModel: "another" };
  await h.props().submitEntry(entry);
  assert.deepEqual(h.state.draftValue.value.provider.models.new_model, { upstreamModel: entry.upstreamModel, ...entry.profile });
  assert.equal(h.closed, false);
  assert.ok(h.props().provider.models.new_model);
  await h.props().submitEntry({ ...entry, alias: "second", upstreamModel: "vendor/second" });
  assert.equal(h.confirmations.length, 2);
  assert.equal(h.confirmations[0].title, "确认添加模型");
  assert.ok(h.state.draftValue.value.provider.models.second);
  assert.ok(h.state.draftValue.value.provider.models.another);
  assert.equal((h.state.draftValue.value.provider.models.old as any).chat.defaults.temperature, 0.5);
  assert.equal(h.closed, false);
  h.props().closeWindow(); assert.equal(h.closed, true);
});

test("确认前不写入，取消不修改草稿；更新已有模型也需确认", async () => {
  const h = setup({ new_model: { upstreamModel: entry.upstreamModel, chat: { defaults: { temperature: 0.2 } } } });
  let finish!: (value: unknown) => void;
  h.dependencies.windows.openDialog = async () => new Promise(resolve => { finish = resolve; });
  const pending = h.props().submitEntry(entry);
  assert.equal((h.state.draftValue.value.provider.models.new_model as any).chat.defaults.temperature, 0.2);
  finish({ reason: "close" }); assert.equal(await pending, false);
  assert.equal(h.closed, false);
  h.dependencies.windows.openDialog = async value => { h.confirmations.push(value); return { reason: "action", actionId: "confirm" }; };
  await h.props().submitEntry({ ...entry, profile: { chat: { defaults: { temperature: 0.2 } } } });
  assert.equal(h.confirmations[0].title, "确认更新模型");
  assert.equal((h.state.draftValue.value.provider.models.new_model as any).chat.defaults.temperature, 0.2);
});

test("别名冲突、重复上游模型和非法字段统一校验，失败保留草稿和窗口", async () => {
  const h = setup({ new_model: { upstreamModel: "other" } });
  await assert.rejects(h.props().submitEntry(entry), /已被其他模型使用/);
  await assert.rejects(h.props().submitEntry({ ...entry, alias: "fresh", upstreamModel: "other" }), /已有其他别名/);
  await assert.rejects(h.props().submitEntry({ ...entry, alias: "fresh", profile: { chat: { limits: { contextTokens: -1 } } } }));
  assert.deepEqual(h.state.draftValue.value.provider.models, { new_model: { upstreamModel: "other" } });
  assert.equal(h.closed, false);
});

test("确认或校验期间目录切换、窗口关闭和并发修改不会覆盖当前草稿", async () => {
  const h = setup();
  h.dependencies.windows.openDialog = async () => { h.state.selectedKey.value = "global_config"; return { reason: "action", actionId: "confirm" }; };
  await assert.rejects(h.props().submitEntry(entry), /目录已切换/);
  h.state.selectedKey.value = "llm_catalog";
  h.dependencies.windows.openDialog = async () => { h.dependencies.windows.close(); return { reason: "action", actionId: "confirm" }; };
  assert.equal(await h.props().submitEntry(entry), false);
  assert.deepEqual(h.state.draftValue.value.provider.models, {});
  const concurrent = setup();
  concurrent.dependencies.validate = async () => { concurrent.state.draftValue.value.provider.models.parallel = { upstreamModel: "parallel" }; return {}; };
  await assert.rejects(concurrent.props().submitEntry(entry), /草稿已变化/);
  assert.deepEqual(concurrent.state.draftValue.value.provider.models, { parallel: { upstreamModel: "parallel" } });
});

test("确认期间目标模型被修改或删除时停止写入，不覆盖也不重新创建", async () => {
  for (const mutation of ["edit", "delete"] as const) {
    const h = setup({ new_model: { upstreamModel: entry.upstreamModel, chat: { defaults: { temperature: 0.1 } } } });
    let confirm!: (value: unknown) => void;
    h.dependencies.windows.openDialog = async () => new Promise(resolve => { confirm = resolve; });
    const pending = h.props().submitEntry({ ...entry, profile: { chat: { defaults: { temperature: 0.2 } } } });
    if (mutation === "edit") (h.state.draftValue.value.provider.models.new_model as any).chat.defaults.temperature = 0.9;
    else delete h.state.draftValue.value.provider.models.new_model;
    confirm({ reason: "action", actionId: "confirm" });
    await assert.rejects(pending, /草稿已变化/);
    if (mutation === "edit") assert.equal((h.state.draftValue.value.provider.models.new_model as any).chat.defaults.temperature, 0.9);
    else assert.equal(h.state.draftValue.value.provider.models.new_model, undefined);
    assert.equal(h.closed, false);
  }
});

test("同一上游的不同参数别名可独立更新，仍阻止无意新增重复别名", async () => {
  const h = setup({
    new_model: { upstreamModel: entry.upstreamModel, chat: { defaults: { temperature: 0.1 } } },
    variant: { upstreamModel: entry.upstreamModel, chat: { defaults: { temperature: 0.9 } } }
  });
  assert.equal(await h.props().submitEntry({ ...entry, profile: { chat: { defaults: { temperature: 0.2 } } } }), true);
  assert.equal((h.state.draftValue.value.provider.models.new_model as any).chat.defaults.temperature, 0.2);
  assert.equal((h.state.draftValue.value.provider.models.variant as any).chat.defaults.temperature, 0.9);
  await assert.rejects(h.props().submitEntry({ ...entry, alias: "third" }), /已有其他别名/);
  assert.deepEqual(Object.keys(h.state.draftValue.value.provider.models), ["new_model", "variant"]);
});
