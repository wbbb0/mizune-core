import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { llmCatalogFileSchema } from "#config/configModel.ts";
import { buildUiTree } from "#data/schema/ui.ts";
import { resolveModelAddSchema, modelOperationOptions, modelProfileFormSchema } from "../../../webui/src/sections/config/modelAddSchema.ts";
import { reactive } from "vue";
import type { UiNode } from "@workbench-kit/vue";

// 执行真实 SFC 的 script setup，保留 Vue 响应式；仅替换网络与挂载钩子。
const source = readFileSync(new URL("../../../webui/src/sections/config/LlmModelAddWindow.vue", import.meta.url), "utf8").match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!;
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const body = js.replace(/import[\s\S]*?from\s+["'][^"']+["'];/g, "");
const vueUrl = new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href;
const module = await import(`data:text/javascript,${encodeURIComponent(`
import { computed, ref } from ${JSON.stringify(vueUrl)};
import { fillMissingModelFields } from ${JSON.stringify(new URL("../../../src/llm/provider/modelDiscoveryMetadata.ts", import.meta.url).href)};
import { modelOperationOptions, modelProfileFormSchema } from ${JSON.stringify(new URL("../../../webui/src/sections/config/modelAddSchema.ts", import.meta.url).href)};
const onMounted = () => {};
export function setup(input, fetcher) {
 const defineProps = () => input;
 const listProviderModels = fetcher;
 ${body}
 return { fetchModels, fetchedModels, filteredModels, selectModel, selectedOperations, canSubmit, activeDraft, operationFilter, suggestedChanges, applySuggestion, activePane, submitModel, submitting, submitError, isUpdating, mode, updateManualUpstreamModel };
}`)}`);

function props(provider: Record<string, unknown> = {}) {
  return reactive({
    provider: { type: "openai_compatible", models: {}, ...provider } as Record<string, any>,
    modelSchema: resolveModelAddSchema(JSON.parse(JSON.stringify(buildUiTree(llmCatalogFileSchema))) as UiNode, "openai_compatible")!,
    editorFeatures: {}, submitEntry: async (_entry: any) => true, closeWindow: () => {}
  });
}

test("未知模型必须手选用途，筛选保留未知，多用途草稿可保存且刷新不覆盖编辑", async () => {
  const slots = [
    { upstreamModel: "known", alias: "known", exists: false, profile: { chat: {} }, suggested: { chat: {} }, sources: ["chat"] },
    { upstreamModel: "unknown", alias: "unknown", exists: false, profile: {}, suggested: {}, sources: ["generic"] },
    { upstreamModel: "embed", alias: "embed", exists: false, profile: { embedding: {} }, suggested: { embedding: {} }, sources: ["embedding"] }
  ];
  const draft = module.setup(props(), async () => ({ kind: "ok", models: slots, warnings: [], endpoint: "test" }));
  await draft.fetchModels();
  draft.operationFilter.value = "embedding";
  assert.deepEqual(draft.filteredModels.value.map((item: any) => item.alias), ["unknown", "embed"]);
  assert.equal(draft.activePane.value, "primary");
  draft.selectModel(slots[1]);
  assert.equal(draft.activePane.value, "secondary");
  assert.equal(draft.canSubmit.value, false);
  draft.selectedOperations.value = ["chat", "embedding"];
  assert.deepEqual(draft.activeDraft.value.profile, { chat: {}, embedding: {} });
  draft.activeDraft.value.profile.chat = { defaults: { temperature: 0 } };
  await draft.fetchModels();
  assert.equal(draft.activeDraft.value.profile.chat.defaults.temperature, 0);
});

test("发现差异逐项应用，不覆盖其他手动设置", async () => {
  const slot = { upstreamModel: "known", alias: "known", exists: true, profile: { chat: { capabilities: { supportsTools: false }, defaults: { temperature: 0 } } }, suggested: { chat: { capabilities: { supportsTools: true } } }, sources: ["test"] };
  const draft = module.setup(props({ models: { known: { upstreamModel: "known", chat: { capabilities: { supportsTools: false }, defaults: { temperature: 0 } } } } }), async () => ({ kind: "ok", models: [slot], warnings: [] }));
  await draft.fetchModels();
  assert.equal(draft.activeDraft.value.profile.chat.capabilities.supportsTools, false);
  assert.equal(draft.suggestedChanges.value.length, 1);
  draft.applySuggestion(draft.suggestedChanges.value[0]);
  assert.equal(draft.activeDraft.value.profile.chat.capabilities.supportsTools, true);
  assert.equal(draft.activeDraft.value.profile.chat.defaults.temperature, 0);
});


test("连续添加后状态和别名立即更新，保留清单且返回来源页签", async () => {
  const input = props();
  const slot = { upstreamModel: "known", alias: "known", exists: false, profile: { chat: {} }, suggested: { chat: {} }, sources: [] };
  input.submitEntry = async entry => {
    input.provider = { ...input.provider, models: { ...input.provider.models, [entry.alias]: { upstreamModel: entry.upstreamModel, ...entry.profile } } };
    return true;
  };
  const draft = module.setup(input, async () => ({ kind: "ok", models: [slot], warnings: [] }));
  await draft.fetchModels();
  draft.selectModel(draft.fetchedModels.value[0]);
  assert.equal(draft.activePane.value, "secondary");
  await draft.submitModel();
  assert.equal(draft.activePane.value, "primary");
  assert.equal(draft.fetchedModels.value[0].exists, true);
  assert.equal(draft.isUpdating.value, true);
  draft.mode.value = "manual";
  draft.updateManualUpstreamModel("known");
  assert.equal(draft.isUpdating.value, true);
  await draft.submitModel();
  assert.equal(draft.activeDraft.value.upstreamModel, "");
  draft.updateManualUpstreamModel("different");
  draft.activeDraft.value.alias = "known";
  draft.selectedOperations.value = ["chat"];
  assert.equal(draft.canSubmit.value, false);
});

test("取消确认保留草稿和页签，提交失败保留全部参数并显示错误", async () => {
  const input = props();
  input.submitEntry = async () => false;
  const draft = module.setup(input, async () => ({ kind: "ok", models: [], warnings: [] }));
  draft.mode.value = "manual";
  draft.updateManualUpstreamModel("known");
  draft.selectedOperations.value = ["chat"];
  draft.activeDraft.value.profile.chat.defaults = { temperature: 0, extra: { custom: true } };
  draft.activePane.value = "secondary";
  await draft.submitModel();
  assert.equal(draft.activePane.value, "secondary");
  assert.equal(draft.activeDraft.value.upstreamModel, "known");
  input.submitEntry = async () => { throw new Error("字段不正确"); };
  await draft.submitModel();
  assert.equal(draft.submitError.value, "字段不正确");
  assert.equal(draft.submitting.value, false);
  assert.deepEqual(draft.activeDraft.value.profile.chat.defaults, { temperature: 0, extra: { custom: true } });
});

test("各供应商新增模型表单使用完整目录 Schema，包括全部默认参数和未来字段", () => {
  const tree = JSON.parse(JSON.stringify(buildUiTree(llmCatalogFileSchema))) as UiNode;
  if (tree.kind !== "record" || tree.value.kind !== "union") return assert.fail("unexpected");
  for (const provider of tree.value.options) {
    if (provider.kind !== "group") return assert.fail("unexpected");
    const type = provider.children.type!.node.schema.value;
    const model: Extract<UiNode, { kind: "group" }> = resolveModelAddSchema(tree, type)!;
    const operations = modelOperationOptions(model);
    const form = modelProfileFormSchema(model, operations.map(option => option.value))!;
    assert.deepEqual(Object.keys(form.children).sort(), Object.keys(model.children).filter(key => key !== "upstreamModel").sort());
    for (const [key, child] of Object.entries(form.children)) assert.equal(child.node, model.children[key]!.node);
    assert.ok(form.children.displayName);
    assert.ok(form.children.chat);
    const limited = modelProfileFormSchema(model, ["embedding"])!;
    assert.ok(limited.children.embedding);
    assert.equal(limited.children.chat, undefined);
  }
  assert.equal(resolveModelAddSchema(tree, "unknown"), undefined);
});

test("保存用途变更后清单按当前草稿筛选，重新选择不恢复已删除用途", async () => {
  const input = props({ models: { known: { upstreamModel: "known", chat: { capabilities: { supportsTools: false } } } } });
  const slot = { upstreamModel: "known", alias: "known", exists: true,
    profile: { chat: { capabilities: { supportsTools: true, supportsVision: true } } },
    suggested: { chat: { capabilities: { supportsTools: true, supportsVision: true } } }, sources: [] };
  input.submitEntry = async entry => {
    input.provider = { ...input.provider, models: { ...input.provider.models, [entry.alias]: { upstreamModel: entry.upstreamModel, ...entry.profile } } };
    return true;
  };
  const draft = module.setup(input, async () => ({ kind: "ok", models: [slot], warnings: [] }));
  await draft.fetchModels();
  assert.equal(draft.activeDraft.value.profile.chat.capabilities.supportsTools, false);
  assert.equal(draft.activeDraft.value.profile.chat.capabilities.supportsVision, true);
  draft.selectedOperations.value = ["embedding"];
  draft.activeDraft.value.profile.embedding.dimensions = 1024;
  await draft.submitModel();
  draft.operationFilter.value = "embedding";
  assert.deepEqual(draft.filteredModels.value.map((model: any) => model.upstreamModel), ["known"]);
  draft.operationFilter.value = "chat";
  assert.deepEqual(draft.filteredModels.value, []);
  draft.operationFilter.value = "unknown";
  assert.deepEqual(draft.filteredModels.value, []);
  draft.selectModel(slot);
  assert.deepEqual(draft.activeDraft.value.profile, { embedding: { dimensions: 1024 } });
  const chatSuggestion = draft.suggestedChanges.value.find((change: any) => change.path.join(".") === "chat");
  assert.ok(chatSuggestion);
  draft.applySuggestion(chatSuggestion);
  assert.equal(draft.activeDraft.value.profile.chat.capabilities.supportsVision, true);
  assert.equal(draft.activeDraft.value.profile.embedding.dimensions, 1024);
});

test("清单加载期间别名被占用时，初次自动选择使用当前生成的可用别名", async () => {
  const input = props();
  let complete!: (value: unknown) => void;
  const draft = module.setup(input, async () => new Promise(resolve => { complete = resolve; }));
  const loading = draft.fetchModels();
  input.provider.models.known = { upstreamModel: "other" };
  complete({ kind: "ok", models: [{ upstreamModel: "known", alias: "known", exists: false, profile: { chat: {} }, suggested: { chat: {} }, sources: [] }], warnings: [] });
  await loading;
  assert.equal(draft.activeDraft.value.alias, "known_2");
  assert.equal(draft.canSubmit.value, true);
});
