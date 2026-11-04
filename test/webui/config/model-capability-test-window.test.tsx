/// <reference lib="dom" />
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// @ts-expect-error local jsdom package has no declarations at this import path
import { JSDOM } from "../../../webui/node_modules/jsdom/lib/api.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const compiler = require(`${root}/webui/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js`);
const ts = require(`${root}/webui/node_modules/typescript/lib/typescript.js`);
const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "SVGElement", "Element", "Node", "MutationObserver"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
}
const vueUrl = new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href;
const dataModule = (source: string) => `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
const kitUrl = dataModule(`import {h,defineComponent} from '${vueUrl}'; export const WorkbenchButton=defineComponent({setup(_,ctx){return ()=>h('button',ctx.attrs,ctx.slots.default?.())}});`);
const apiUrl = dataModule(`export const testProviderModel=(...args)=>globalThis.__modelProbeMock(...args);`);
const filename = `${root}/webui/src/sections/config/LlmModelTestWindow.vue`;
const descriptor = compiler.parse(readFileSync(filename, "utf8"), { filename }).descriptor;
let source = ts.transpileModule(compiler.compileScript(descriptor, { id: filename, inlineTemplate: true }).content, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText as string;
for (const [from, to] of Object.entries({ vue: vueUrl, "@workbench-kit/vue": kitUrl, "@/api/editor": apiUrl })) {
  source = source.split(`from "${from}"`).join(`from "${to}"`).split(`from '${from}'`).join(`from '${to}'`);
}
const { mount, flushPromises } = await import(new URL("../../../webui/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs", import.meta.url).href);
const { default: Component } = await import(dataModule(source));
const provider = { type: "openai", baseUrl: "https://draft.example/v1", apiKey: "draft-test-key", proxy: true };
const model = { upstreamModel: "draft-model", chat: {} };
const success = (operation: string) => ({ operation, status: "passed", durationMs: 1, message: "有效响应" });
const mock = (fn: (...args: any[]) => unknown) => { (globalThis as any).__modelProbeMock = fn; };

function createWindow() { return mount(Component, { props: { provider, model } }); }
function button(wrapper: any, text: string) { return wrapper.findAll("button").find((item: any) => item.text().includes(text)); }

test("测试窗挂载不请求，默认仅选便宜用途且不修改模型草稿", async () => {
  let count = 0; mock(() => { count++; });
  const wrapper = createWindow();
  await flushPromises();
  const inputs = wrapper.findAll('input[type="checkbox"]');
  assert.deepEqual(inputs.map((input: any) => (input.element as HTMLInputElement).checked), [true, true, false, false, false, false]);
  assert.equal(count, 0);
  assert.equal(button(wrapper, "开始测试").text(), "开始测试（2 项）");
  assert.deepEqual(model, { upstreamModel: "draft-model", chat: {} });
  wrapper.unmount();
});

test("点击后使用当前草稿串行单次请求，媒体须手动勾选，失败结果不会重试", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  mock(async (draftProvider, draftModel, operation) => {
    assert.equal(draftProvider.apiKey, provider.apiKey);
    assert.equal(draftProvider.proxy, true);
    assert.equal(draftModel.upstreamModel, "draft-model");
    calls.push(operation);
    if (operation === "chat") await pending;
    return operation === "embedding" ? { ...success(operation), status: "inconclusive", message: "上游限流；未确认" } : success(operation);
  });
  const wrapper = createWindow();
  await wrapper.findAll('input[type="checkbox"]')[5].setValue(true);
  await button(wrapper, "开始测试").trigger("click");
  await flushPromises();
  assert.deepEqual(calls, ["chat"]);
  assert.equal(wrapper.findAll('input[type="checkbox"]').every((input: any) => input.element.disabled), true);
  release(); await flushPromises();
  assert.deepEqual(calls, ["chat", "embedding", "image"]);
  assert.match(wrapper.text(), /未确认/);
  assert.match(wrapper.text(), /图像生成/);
  assert.equal(wrapper.emitted("update:modelValue"), undefined);
  wrapper.unmount();
});

test("停止会中止在途请求且不再发送下一项，重新开始仍可正常工作", async () => {
  const calls: string[] = [];
  let signal: AbortSignal | undefined;
  mock((_provider, _model, operation, activeSignal: AbortSignal) => {
    calls.push(operation); signal = activeSignal;
    return new Promise((_resolve, reject) => activeSignal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
  });
  const wrapper = createWindow();
  await button(wrapper, "开始测试").trigger("click"); await flushPromises();
  await button(wrapper, "停止").trigger("click"); await flushPromises();
  assert.equal(signal?.aborted, true);
  assert.deepEqual(calls, ["chat"]);
  assert.match(wrapper.text(), /已停止测试/);
  assert.equal(wrapper.find('[role="alert"]').exists(), false);
  mock(async (_provider, _model, operation) => success(operation));
  await button(wrapper, "开始测试").trigger("click"); await flushPromises();
  assert.match(wrapper.text(), /通过/);
  wrapper.unmount();
});

test("关闭卸载测试窗会取消在途请求，返回内容按纯文本展示", async () => {
  let signal: AbortSignal | undefined;
  mock((_provider, _model, _operation, activeSignal: AbortSignal) => {
    signal = activeSignal;
    return new Promise((_resolve, reject) => activeSignal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  });
  const wrapper = createWindow();
  await button(wrapper, "开始测试").trigger("click"); await flushPromises();
  wrapper.unmount(); await flushPromises();
  assert.equal(signal?.aborted, true);
  mock(async (_provider, _model, operation) => ({ ...success(operation), message: '<script>alert("x")</script>' }));
  const next = createWindow();
  await button(next, "开始测试").trigger("click"); await flushPromises();
  assert.equal(next.find("script").exists(), false);
  assert.match(next.text(), /<script>/);
  next.unmount();
});

test("真实模型目录经 provider union 和 models record 递归后每个模型只出现一个测试入口，点击读取最新草稿", async () => {
  const { llmCatalogFileSchema } = await import("../../../src/config/configModel.ts");
  const { buildUiTree } = await import("../../../src/data/schema/ui.ts");
  const { createModelTestNodeActions } = await import("../../../webui/src/sections/config/modelTestActions.ts");
  const icons = dataModule(`import {h} from '${vueUrl}'; ${["Plus", "Trash2", "ArrowUp", "ArrowDown", "Pencil", "Check", "Undo2", "Copy", "Play"].map(icon => `export const ${icon}=()=>h('i');`).join("\n")}`);
  const primitives = dataModule(`import {h,defineComponent} from '${vueUrl}';export const TreeNodeShell=defineComponent({setup(_,ctx){return ()=>h('div',[ctx.slots.label?.(),ctx.slots.actions?.(),ctx.slots.default?.()])}});`);
  const leaf = dataModule(`import {h} from '${vueUrl}'; export default {render(){return h('span')}};`);
  const nodeFilename = `${root}/vendor/workbench-kit/packages/vue-resource-editor/src/components/SchemaNode.vue`;
  const parsed = compiler.parse(readFileSync(nodeFilename, "utf8"), { filename: nodeFilename }).descriptor;
  let nodeSource = ts.transpileModule(compiler.compileScript(parsed, { id: nodeFilename, inlineTemplate: true }).content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText as string;
  const moduleFile = (path: string) => new URL(`../../../vendor/workbench-kit/packages/vue-resource-editor/src/${path}`, import.meta.url).href;
  for (const [from, to] of Object.entries({
    vue: vueUrl, "lucide-vue-next": icons, "@workbench-kit/vue-workbench": primitives,
    "./SchemaField.vue": leaf, "./GroupedOptionPicker.vue": leaf,
    "../schemaVariant": moduleFile("schemaVariant.ts"), "../editorState": moduleFile("editorState.ts")
  })) nodeSource = nodeSource.split(`from "${from}"`).join(`from "${to}"`).split(`from '${from}'`).join(`from '${to}'`);
  const { default: SchemaNode } = await import(dataModule(nodeSource));
  let resource = "llm_catalog";
  const draft = {
    provider: { type: "openai", baseUrl: "https://old.example/v1", apiKey: "old-key", proxy: false, models: {
      first: { upstreamModel: "first-model", chat: {} }, second: { upstreamModel: "second-model", embedding: {} }
    } }
  };
  const opened: any[] = [];
  const actions = createModelTestNodeActions({ getResourceKey: () => resource, getDraft: () => draft, openTest: context => opened.push(context) });
  const wrapper = mount(SchemaNode, { props: { node: buildUiTree(llmCatalogFileSchema), modelValue: draft, nodeActions: actions } });
  const buttons = wrapper.findAll('button[title="测试模型能力与连通性"]');
  assert.equal(buttons.length, 2);
  assert.equal(opened.length, 0);
  draft.provider.apiKey = "new-unsaved-key";
  draft.provider.proxy = true;
  draft.provider.models.first.upstreamModel = "new-unsaved-model";
  await buttons[0].trigger("click");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].providerName, "provider");
  assert.equal(opened[0].modelName, "first");
  assert.equal(opened[0].provider.apiKey, "new-unsaved-key");
  assert.equal(opened[0].provider.proxy, true);
  assert.equal(opened[0].model.upstreamModel, "new-unsaved-model");
  assert.equal(opened[0].provider.models, undefined);
  draft.provider.apiKey = "edited-again";
  assert.equal(opened[0].provider.apiKey, "new-unsaved-key");
  resource = "global_config";
  await buttons[1].trigger("click");
  assert.equal(opened.length, 1);
  assert.equal(actions({ node: { kind: "group", schema: { kind: "object", optional: false, hasDefault: false }, children: {} }, path: ["provider", "models", "first"], value: {} }).length, 0);
  wrapper.unmount();
});
