import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { nextTick, reactive } from "vue";

// 执行真实 SFC 的 script setup，保留 Vue 响应式；仅替换网络与挂载钩子。
const source = readFileSync(new URL("../../../webui/src/sections/config/LlmModelAddWindow.vue", import.meta.url), "utf8").match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!;
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const body = js.replace(/import[\s\S]*?from\s+["'][^"']+["'];/g, "");
const vueUrl = new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href;
const module = await import(`data:text/javascript,${encodeURIComponent(`
import { computed, ref, watch } from ${JSON.stringify(vueUrl)};
const onMounted = () => {};
export function setup(input, fetcher) {
 const defineProps = () => input;
 const listProviderModels = fetcher;
 ${body}
 return { fetchModels, filteredModels, selectModel, selectedOperations, canSubmit, activeDraft, operationFilter, suggestedChanges, applySuggestion };
}`)}`);

test("未知模型必须手选用途，筛选保留未知，多用途草稿可保存且刷新不覆盖编辑", async () => {
  const slots = [
    { upstreamModel: "known", alias: "known", exists: false, profile: { chat: {} }, suggested: { chat: {} }, sources: ["chat"] },
    { upstreamModel: "unknown", alias: "unknown", exists: false, profile: {}, suggested: {}, sources: ["generic"] },
    { upstreamModel: "embed", alias: "embed", exists: false, profile: { embedding: {} }, suggested: { embedding: {} }, sources: ["embedding"] }
  ];
  const values = reactive<Record<string, any>>({});
  const draft = module.setup({ provider: {}, existingAliases: [], values }, async () => ({ kind: "ok", models: slots, warnings: [], endpoint: "test" }));
  await draft.fetchModels();
  draft.operationFilter.value = "embedding";
  assert.deepEqual(draft.filteredModels.value.map((item: any) => item.alias), ["unknown", "embed"]);
  draft.selectModel(slots[1]);
  assert.equal(draft.canSubmit.value, false);
  draft.selectedOperations.value = ["chat", "embedding"];
  await nextTick();
  assert.deepEqual(values.entry.profile, { chat: {}, embedding: {} });
  draft.activeDraft.value.profile.chat = { defaults: { temperature: 0 } };
  await draft.fetchModels();
  assert.equal(draft.activeDraft.value.profile.chat.defaults.temperature, 0);
});

test("发现差异逐项应用，不覆盖其他手动设置", async () => {
  const slot = { upstreamModel: "known", alias: "known", exists: true, profile: { chat: { capabilities: { supportsTools: false }, defaults: { temperature: 0 } } }, suggested: { chat: { capabilities: { supportsTools: true } } }, sources: ["test"] };
  const draft = module.setup({ provider: { models: { known: { upstreamModel: "known" } } }, existingAliases: ["known"], values: reactive({}) }, async () => ({ kind: "ok", models: [slot], warnings: [] }));
  await draft.fetchModels();
  assert.equal(draft.activeDraft.value.profile.chat.capabilities.supportsTools, false);
  assert.equal(draft.suggestedChanges.value.length, 1);
  draft.applySuggestion(draft.suggestedChanges.value[0]);
  assert.equal(draft.activeDraft.value.profile.chat.capabilities.supportsTools, true);
  assert.equal(draft.activeDraft.value.profile.chat.defaults.temperature, 0);
});
