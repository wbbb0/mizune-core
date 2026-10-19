import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { createInternalApiApp, createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";

test("供应商变更原子更新全局、其他实例、自定义路径，并拒绝外部变更后的旧 revision", async () => {
  const deps = createInternalApiDeps();
  const runtime = deps.config.configRuntime;
  const customPath = join(runtime.configDir, "custom-instance.yml");
  runtime.instanceConfigPath = customPath;
  await mkdir(join(runtime.configDir, "instances"), { recursive: true });
  const paths = [runtime.globalConfigPath, customPath, join(runtime.configDir, "instances", "other.yml")];
  for (const path of paths) await writeFile(path, YAML.stringify({ context: { embedding: { model: { provider: "old", model: "vec" } } } }));
  const provider = { type: "openrouter", models: { vec: { upstreamModel: "qwen/qwen3-embedding-8b", embedding: {} } } };
  await writeFile(runtime.llmCatalogPath, YAML.stringify({ old: provider }));
  await writeFile(runtime.llmRoutingPresetCatalogPath, "default: {}\n");
  const app = await createInternalApiApp(deps);
  try {
    const impact = await app.inject({ method: "POST", url: "/api/editors/llm_catalog/provider-impact", payload: { provider: "old" } });
    assert.equal(impact.statusCode, 200);
    assert.deepEqual(new Set(impact.json().embeddingReferences), new Set(paths));
    const revision = (await app.inject({ method: "GET", url: "/api/editors/llm_catalog" })).json().editor.revision;
    await writeFile(customPath, YAML.stringify({ context: { embedding: { model: { provider: "old", model: "other" } } } }));
    const save = (revision: string, value: unknown, mutations: unknown[]) => app.inject({ method: "POST", url: "/api/editors/llm_catalog/save", payload: { value, mutations, revision } });
    const rename = [{ kind: "rename_provider", provider: "old", nextProvider: "renamed" }];
    const stale = await save(revision, { renamed: provider }, rename);
    assert.equal(stale.statusCode, 409);
    assert.ok(YAML.parse(await readFile(runtime.llmCatalogPath, "utf8")).old);
    const latest = (await app.inject({ method: "GET", url: "/api/editors/llm_catalog" })).json().editor.revision;
    assert.equal((await save(latest, { renamed: provider }, rename)).statusCode, 200);
    for (const path of paths) assert.equal(YAML.parse(await readFile(path, "utf8")).context.embedding.model.provider, "renamed");
    const afterRename = (await app.inject({ method: "GET", url: "/api/editors/llm_catalog" })).json().editor.revision;
    assert.equal((await save(afterRename, {}, [{ kind: "delete_provider", provider: "renamed" }])).statusCode, 200);
    for (const path of paths) assert.equal(YAML.parse(await readFile(path, "utf8")).context.embedding.model, null);
  } finally { await app.close(); }
});
