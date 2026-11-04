import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { isReactive, reactive } from "vue";
import { loadConfig } from "../../src/config/config.ts";
import { createEditorService, EditorRevisionConflictError } from "../../src/internalApi/application/editorService.ts";
import { buildUiTreeFromMeta } from "../../src/data/schema/ui.ts";
import { createEditorModelLoader, type EditorModelResponse } from "../../webui/src/api/editorModelLoader.ts";
import { withConfigDir, writeLlmCatalog, writeYaml } from "../helpers/config-test-support.tsx";

async function withEditor(fn: (service: ReturnType<typeof createEditorService>, configDir: string) => Promise<void>) {
  await withConfigDir("editor-payload", async configDir => {
    await writeLlmCatalog(configDir);
    await writeYaml(join(configDir, "global.yml"), { appName: "editor-test" });
    await writeYaml(join(configDir, "instances", "default.yml"), { appName: "instance-test" });
    const config = loadConfig({ CONFIG_DIR: configDir });
    const service = createEditorService({
      config,
      configManager: { requestReload() {}, runWriteTransaction: async fn => fn() },
      whitelistStore: { async reloadFromDisk() { return { users: [], groups: [] }; } },
      scheduler: { async reloadFromStore() {} }
    });
    await fn(service, configDir);
  });
}

test("editor transports metadata once and hydrates every resource without losing its UI tree or values", async () => {
  await withEditor(async service => {
    const responses: EditorModelResponse[] = [];
    const load = createEditorModelLoader(async path => {
      const url = new URL(path, "http://editor.test");
      const result = await service.loadResourceModel(url.pathname.split("/").at(-1)!, url.searchParams.get("schemaVersion") ?? undefined);
      const response = JSON.parse(JSON.stringify(result)) as EditorModelResponse;
      responses.push(response);
      return response;
    });
    for (const { key } of (await service.listResources()).resources) {
      const first = await load(key);
      const full = responses.at(-1)!;
      assert.ok(full.schema);
      assert.equal("uiTree" in full.editor, false);
      assert.equal("schemaMeta" in full.editor, false);
      assert.deepEqual(first.editor.uiTree, buildUiTreeFromMeta(full.schema.meta));
      const reactiveEditor = reactive(first.editor);
      assert.equal(isReactive(reactiveEditor.uiTree), false);
      assert.equal(isReactive(reactiveEditor.schemaMeta), false);
      assert.equal(isReactive(reactiveEditor.currentValue), true);
      const refreshed = await load(key);
      assert.equal(responses.at(-1)!.schema, undefined);
      assert.equal(first.editor.uiTree, refreshed.editor.uiTree);
      assert.deepEqual(first.editor, refreshed.editor);
      const oldPayload = JSON.stringify({ editor: first.editor }).length;
      assert.ok(JSON.stringify(full).length < oldPayload / 2, `${key} should omit repeated UI tree metadata`);
      const unknownVersion = await service.loadResourceModel(key, "outdated-version");
      assert.ok(unknownVersion.schema, "a stale client must receive the current schema");
    }
  });
});

test("lightweight reload after save returns current disk values and fresh revisions while preserving stale-write protection", async () => {
  await withEditor(async service => {
    const first = await service.loadResourceModel("llm_catalog");
    const before = first.editor as { currentValue: unknown; revision: string };
    await service.saveDraft("llm_catalog", {
      example: { type: "openai", baseUrl: "https://example.test/v1", apiKey: "test", models: {} }
    }, [], before.revision);
    const refreshed = await service.loadResourceModel("llm_catalog", first.schemaVersion);
    const after = refreshed.editor as { currentValue: unknown; revision: string };
    assert.equal(refreshed.schema, undefined);
    assert.notEqual(before.revision, after.revision);
    assert.ok((after.currentValue as Record<string, unknown>).example);
    await assert.rejects(service.saveDraft("llm_catalog", before.currentValue, [], before.revision), EditorRevisionConflictError);
    await service.saveDraft("config", { appName: "saved-instance" });
    const instance = await service.loadResourceModel("config");
    assert.equal((instance.editor as { effectiveValue: { appName: string } }).effectiveValue.appName, "saved-instance");
  });
});

test("schema cache accepts a new server schema and rejects an unmatched omitted schema", async () => {
  await withEditor(async service => {
    const initial = JSON.parse(JSON.stringify(await service.loadResourceModel("config"))) as EditorModelResponse;
    let next = initial;
    const load = createEditorModelLoader(async () => next);
    const first = await load("config");
    next = { ...initial, schemaVersion: "updated", schema: { ...initial.schema!, meta: { ...initial.schema!.meta, title: "新版配置" } } };
    const updated = await load("config");
    assert.notEqual(first.editor.uiTree, updated.editor.uiTree);
    assert.equal(updated.editor.schemaMeta.title, "新版配置");
    next = { schemaVersion: "updated", editor: initial.editor };
    assert.equal((await load("config")).editor.uiTree, updated.editor.uiTree);
    next = { schemaVersion: "missing", editor: initial.editor };
    await assert.rejects(load("config"), /Schema 版本不一致/);
  });
});

test("overlapping reloads hydrate with the schema version declared by each request", async () => {
  await withEditor(async service => {
    const initial = JSON.parse(JSON.stringify(await service.loadResourceModel("config"))) as EditorModelResponse;
    let call = 0;
    let finishOlder!: (response: EditorModelResponse) => void;
    const load = createEditorModelLoader(async path => {
      call++;
      if (call === 1) return initial;
      if (call === 2) return new Promise<EditorModelResponse>(resolve => { finishOlder = resolve; });
      if (call === 3) return { ...initial, schemaVersion: "new-version" };
      assert.ok(path.endsWith("?schemaVersion=new-version"));
      return { schemaVersion: "new-version", editor: initial.editor };
    });
    const first = await load("config");
    const olderRequest = load("config");
    const newer = await load("config");
    finishOlder({ schemaVersion: initial.schemaVersion, editor: initial.editor });
    assert.equal((await olderRequest).editor.uiTree, first.editor.uiTree);
    assert.equal((await load("config")).editor.uiTree, newer.editor.uiTree);
  });
});

test("layered editor preview agrees with the backend when switching safety provider", async () => {
  const { computeDraftEffectiveValue } = await import("../../vendor/workbench-kit/packages/vue-resource-editor/src/editorState.ts");
  await withEditor(async (service, configDir) => {
    await writeYaml(join(configDir, "global.yml"), { contentSafety: { provider: "aliyun", config: { accessKeyId: "ali", proxy: true, timeoutMs: 12000 } } });
    await writeYaml(join(configDir, "instances", "default.yml"), { contentSafety: { provider: "openai", config: { apiKey: "openai-test-key" } } });
    const load = createEditorModelLoader(async () => JSON.parse(JSON.stringify(await service.loadResourceModel("config"))) as EditorModelResponse);
    const { editor } = await load("config");
    const effective = computeDraftEffectiveValue(editor, editor.currentValue) as { contentSafety: { config: unknown } };
    assert.deepEqual(effective.contentSafety.config, (editor.effectiveValue as { contentSafety: { config: unknown } }).contentSafety.config);
    assert.deepEqual((effective.contentSafety.config as { proxy: boolean }).proxy, false);
    assert.deepEqual((effective.contentSafety.config as { timeoutMs: number }).timeoutMs, 6000);
  });
});
