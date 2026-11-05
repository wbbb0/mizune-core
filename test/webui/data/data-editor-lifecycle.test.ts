/// <reference lib="dom" />
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
// @ts-expect-error local jsdom package has no declarations at this import path
import { JSDOM } from "../../../webui/node_modules/jsdom/lib/api.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "SVGElement", "Element", "Node"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
const { effectScope, nextTick } = await import("vue");

// 执行真实 Data composable；只替换网络、工作台服务和与本测试无关的编辑器草稿封装。
const source = readFileSync(new URL("../../../webui/src/composables/sections/useDataSection.ts", import.meta.url), "utf8");
const body = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
  .replace(/import[\s\S]*?from\s+["'][^"']+["'];/g, "").replace("export const useDataSection", "const useDataSection");
const vueUrl = new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href;
const module = await import(`data:text/javascript,${encodeURIComponent(`
import { computed, defineComponent, h, ref, watch } from ${JSON.stringify(vueUrl)};
const createSharedSectionState = factory => factory;
const useWorkbenchToasts = () => ({ push() {} });
const useWorkbenchNavigation = () => ({ showArea() {} });
const useWorkbenchWindows = () => ({});
const useEditorDraftState = () => {
 const draftValue = ref(null);
 return { draftValue, referenceValue: ref(null), storedDraftValue: ref(null), effectiveValue: ref(null), isDirty: ref(true), resetDraft: value => { draftValue.value = value; } };
};
export function setup(dataApi, editorApi) {
 ${body}
 return useDataSection();
}`)}`);
const resource = (key: string, value: unknown) => ({ resource: { key, shape: "singleton", accessMode: "editable", value } });
const entry = (key: string) => ({ id: `registry:${key}`, key, source: "registry", kind: "singleton", accessMode: "editable" });
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(done => { resolve = done; });
  return { promise, resolve };
}

test("Data A→B→A 忽略上次 A 的载入与保存响应，并重置忙碌状态", async () => {
  const scope = effectScope();
  const loads = [deferred(), deferred(), deferred()];
  let loadIndex = 0;
  const save = deferred();
  const state = scope.run(() => module.setup({ get: () => loads[loadIndex++]!.promise, patchSingleton: () => save.promise }, {}));
  try {
    state.resources.value = [entry("a"), entry("b")];
    state.selectResource("registry:a");
    loads[0]!.resolve(resource("a", { revision: "old", name: "A" }));
    await nextTick();
    state.updateRegistryDraft({ revision: "old", name: "pending" });
    const pendingSave = state.saveRegistrySingleton();
    assert.equal(state.saving.value, true);
    state.selectResource("registry:b");
    assert.equal(state.saving.value, false);
    state.selectResource("registry:a");
    loads[2]!.resolve(resource("a", { revision: "new", name: "new A" }));
    await nextTick();
    state.updateRegistryDraft({ revision: "new", name: "local edit" });
    loads[1]!.resolve(resource("b", { name: "B" }));
    save.resolve({ value: { revision: "saved-old", name: "pending" } });
    await pendingSave;
    await nextTick();
    assert.equal(state.registryDraftValue.value.name, "local edit");
    assert.equal(state.registryStoredValue.value.revision, "new");
    assert.equal(state.loading.value, false);
    assert.equal(state.saving.value, false);
  } finally { scope.stop(); }
});

test("Data 旧 A 载入响应不能覆盖重新选择 A 后的草稿", async () => {
  const scope = effectScope();
  const loads = [deferred(), deferred(), deferred()];
  let loadIndex = 0;
  const state = scope.run(() => module.setup({ get: () => loads[loadIndex++]!.promise }, {}));
  try {
    state.resources.value = [entry("a"), entry("b")];
    state.selectResource("registry:a");
    state.selectResource("registry:b");
    state.selectResource("registry:a");
    loads[2]!.resolve(resource("a", { name: "new A" }));
    await nextTick();
    state.updateRegistryDraft({ name: "local" });
    loads[0]!.resolve(resource("a", { name: "old A" }));
    loads[1]!.resolve(resource("b", { name: "B" }));
    await nextTick();
    assert.equal(state.registryDraftValue.value.name, "local");
  } finally { scope.stop(); }
});

test("Data 普通编辑器保存成功后仍重新载入，外部刷新在保存时被阻止", async () => {
  const scope = effectScope();
  const save = deferred();
  let loads = 0;
  const state = scope.run(() => module.setup({}, {
    load: async () => { loads++; return { editor: { kind: "single" } }; },
    save: () => save.promise
  }));
  try {
    state.resources.value = [{ id: "editor:a", key: "a", source: "editor", kind: "single", editable: true }];
    state.selectResource("editor:a");
    await nextTick();
    const pendingSave = state.save();
    assert.equal(state.saving.value, true);
    await state.refreshSelected();
    assert.equal(loads, 1);
    save.resolve({ path: "test" });
    await pendingSave;
    assert.equal(loads, 2);
    assert.equal(state.saving.value, false);
  } finally { scope.stop(); }
});

test("Data 通用草稿不静默修补角色来源字段，验证失败保留用户草稿及已保存值", async () => {
  const scope = effectScope();
  const initialProfile = {
    revision: "rev_1",
    confirmed: ["persona", "social"],
    persona: {},
    social: {
      referenceImages: [
        {
          id: "ref_1",
          fileId: "cf_origin_1",
          label: "初始立绘",
          subject: "主角",
          description: "初始描述"
        }
      ]
    },
    embodiment: {}
  };
  let validatedValue: unknown;
  const state = scope.run(() => module.setup({
    get: async () => resource("character_profile", structuredClone(initialProfile)),
    validateSingleton: async (_key: string, value: unknown) => {
      validatedValue = JSON.parse(JSON.stringify(value));
      throw new Error("已存在参考图的来源字段不可修改");
    }
  }, {}));
  try {
    state.resources.value = [entry("character_profile")];
    state.selectResource("registry:character_profile");
    await nextTick();
    await nextTick();

    // 尝试在草稿中修改已存条目的 fileId 与 subject，同时修改 label 与 description
    state.updateRegistryDraft({
      ...initialProfile,
      social: {
        referenceImages: [
          {
            id: "ref_1",
            fileId: "cf_tampered",
            label: "更新后的标签",
            subject: "篡改主体",
            description: "更新后的描述"
          }
        ]
      }
    });
    const updatedItem = state.registryDraftValue.value.social.referenceImages[0];
    assert.equal(updatedItem.fileId, "cf_tampered");
    assert.equal(updatedItem.subject, "篡改主体");
    assert.equal(updatedItem.label, "更新后的标签");
    assert.equal(updatedItem.description, "更新后的描述");
    await state.validateRegistrySingleton();
    assert.deepEqual(validatedValue, JSON.parse(JSON.stringify(state.registryDraftValue.value)));
    assert.equal(state.registryDraftValue.value.social.referenceImages[0].fileId, "cf_tampered");
    assert.equal(state.registryStoredValue.value.social.referenceImages[0].fileId, "cf_origin_1");
    assert.equal(state.validating.value, false);

    // 允许删除条目
    state.updateRegistryDraft({
      ...initialProfile,
      social: {
        referenceImages: []
      }
    });
    assert.deepEqual(state.registryDraftValue.value.social.referenceImages, []);
  } finally {
    scope.stop();
  }
});

test("参考图专用组件只编辑标签和描述，保留来源并支持预览、删除及忙碌只读", async () => {
  const require = createRequire(import.meta.url);
  const compiler = require("../../../webui/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js");
  const filename = new URL("../../../webui/src/sections/data/CharacterReferenceImagesSection.vue", import.meta.url);
  const descriptor = compiler.parse(readFileSync(filename, "utf8"), { filename: filename.pathname }).descriptor;
  const dataModule = (code: string) => `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
  const apiUrl = dataModule("export const fileApi = { getChatFileContentUrlById(id) { return '/api/chat-files/' + encodeURIComponent(id) + '/content'; } };");
  const iconsUrl = dataModule("export const ExternalLink = () => null; export const Image = () => null; export const Trash2 = () => null;");
  let code = ts.transpileModule(compiler.compileScript(descriptor, { id: "reference-images", inlineTemplate: true }).content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  for (const [from, to] of Object.entries({ vue: vueUrl, "@/api/workspace": apiUrl, "lucide-vue-next": iconsUrl })) {
    code = code.replaceAll(`from "${from}"`, `from "${to}"`);
  }
  const { default: component } = await import(dataModule(code));
  const { mount } = await import(new URL("../../../webui/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs", import.meta.url).href);
  const storedValue = {
    revision: "rev_1", social: { referenceImages: [{ id: "ref_1", fileId: "file_origin", label: "初始立绘", subject: "左侧角色", description: "初始描述" }] }
  };
  const wrapper = mount(component, { props: { modelValue: structuredClone(storedValue), storedValue } });
  try {
    assert.equal(wrapper.findAll("input").length, 1);
    assert.equal(wrapper.get("img").attributes("src"), "/api/chat-files/file_origin/content");
    assert.match(wrapper.text(), /file_origin/);
    assert.match(wrapper.text(), /左侧角色/);
    await wrapper.get("input").setValue("新标签");
    let next = wrapper.emitted("update:modelValue").at(-1)[0];
    assert.equal(next.social.referenceImages[0].label, "新标签");
    assert.equal(next.social.referenceImages[0].fileId, "file_origin");
    assert.equal(next.social.referenceImages[0].subject, "左侧角色");
    await wrapper.setProps({ modelValue: next });
    await wrapper.get("textarea").setValue("新描述");
    next = wrapper.emitted("update:modelValue").at(-1)[0];
    assert.equal(next.social.referenceImages[0].description, "新描述");
    assert.equal(next.social.referenceImages[0].label, "新标签");
    assert.deepEqual(storedValue.social.referenceImages[0], { id: "ref_1", fileId: "file_origin", label: "初始立绘", subject: "左侧角色", description: "初始描述" });
    await wrapper.setProps({ modelValue: next, readOnly: true });
    assert.equal(wrapper.get("input").element.disabled, true);
    assert.equal(wrapper.get("textarea").element.disabled, true);
    assert.equal(wrapper.get('button[title="删除此参考图"]').element.disabled, true);
    const beforeDisabledClick = wrapper.emitted("update:modelValue").length;
    await wrapper.get('button[title="删除此参考图"]').trigger("click");
    assert.equal(wrapper.emitted("update:modelValue").length, beforeDisabledClick);
    await wrapper.setProps({ readOnly: false });
    await wrapper.get('button[title="删除此参考图"]').trigger("click");
    assert.deepEqual(wrapper.emitted("update:modelValue").at(-1)[0].social.referenceImages, []);
  } finally {
    wrapper.unmount();
  }
});
