import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { effectScope, nextTick } from "vue";

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
