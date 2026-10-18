import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { ref, reactive } from "vue";

// 执行真实 composable，只替换窗口服务和资源客户端，保留 Vue 响应式草稿。
const source = readFileSync(new URL("../../../webui/src/composables/sections/useConfigSection.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const vueUrl = new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href;
const moduleSource = js.replace(/import[\s\S]*?from\s+["']([^"']+)["'];/g, (statement, name: string) => {
  if (name === "vue") return statement.replace('"vue"', JSON.stringify(vueUrl));
  return "";
});
const factory = await import(`data:text/javascript,${encodeURIComponent(`
let harness;
const createSharedSectionState = fn => fn;
const createResourceEditorState = () => harness.state;
const useWorkbenchWindows = () => harness.windows;
const useWorkbenchToasts = () => ({ push: value => harness.errors.push(value) });
const editorApi = {}, LlmModelAddWindow = {};
const clearEditorMutations = () => {};
export function setup(value) { harness = value; return useConfigSection(); }
${moduleSource}`)}`);

function setup(models: Record<string, unknown> = {}) {
  let definition: any;
  let resolveWindow: (value: unknown) => void = () => {};
  const errors: unknown[] = [];
  const state = {
    selectedKey: ref("llm_catalog"), model: ref(null), loading: ref(false), saving: ref(false), validating: ref(false),
    draftValue: ref({ provider: { models } }),
    updateDraft(value: any) { state.draftValue.value = value; }
  };
  const section = factory.setup({ state, errors, windows: { open(value: any) {
    definition = value;
    return new Promise(resolve => { resolveWindow = resolve; });
  } } });
  const pending = section.beforeRecordMutation({ kind: "add", path: ["provider", "models"] });
  return { state, errors, pending, action: definition.actions[0], close: () => resolveWindow({ reason: "close" }) };
}

const entry = { alias: "new_model", upstreamModel: "vendor/model", capabilities: { modelType: "chat", supportsTools: true } };

test("添加模型在关闭前写入响应式草稿，保留嵌套配置和期间的编辑", async () => {
  const h = setup({ old: { upstreamModel: "old", apiParameters: reactive({ temperature: 0.5 }) } });
  h.state.draftValue.value.provider.models.another = { upstreamModel: "another" };
  h.action.run({ values: { canSubmit: true, entry } });
  assert.deepEqual(h.state.draftValue.value.provider.models.new_model, { upstreamModel: entry.upstreamModel, ...entry.capabilities });
  assert.deepEqual(h.state.draftValue.value.provider.models.old, { upstreamModel: "old", apiParameters: { temperature: 0.5 } });
  assert.ok(h.state.draftValue.value.provider.models.another);
  assert.deepEqual(h.errors, []);
  h.close();
  assert.equal(await h.pending, false);
});

test("更新已有模型保留 API 参数；取消不修改草稿", async () => {
  const h = setup({ new_model: { upstreamModel: entry.upstreamModel, apiParameters: { temperature: 0.2 } } });
  h.action.run({ values: { canSubmit: true, entry } });
  assert.deepEqual((h.state.draftValue.value.provider.models.new_model as any).apiParameters, { temperature: 0.2 });
  h.close();
  await h.pending;
  const cancelled = setup();
  cancelled.close();
  await cancelled.pending;
  assert.deepEqual(cancelled.state.draftValue.value.provider.models, {});
});

test("别名冲突或写入失败时抛错阻止关闭并通知用户", async () => {
  const h = setup({ new_model: { upstreamModel: "other" } });
  assert.throws(() => h.action.run({ values: { canSubmit: true, entry } }), /已被其他模型使用/);
  assert.equal(h.errors.length, 1);
  h.state.updateDraft = () => { throw new Error("write failed"); };
  assert.throws(() => h.action.run({ values: { canSubmit: true, entry: { ...entry, alias: "fresh" } } }), /write failed/);
  assert.equal(h.errors.length, 2);
  h.close();
  await h.pending;
});
