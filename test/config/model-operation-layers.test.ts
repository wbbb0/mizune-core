import test from "node:test";
import assert from "node:assert/strict";
import { mergeConfigLayers } from "#config/mergeConfigLayers.ts";
import { mutateEmbeddingConfigReference } from "#config/embeddingConfigReferences.ts";
import { fileConfigSchema } from "#config/configModel.ts";

test("向量目标整项覆盖；null 禁用且删除供应商不重新继承", () => {
  const global = { context: { embedding: { model: { provider: "global", model: "embedding" } } } };
  const instance = { context: { embedding: { model: { provider: "local", model: "model" } } } };
  const deleted = mutateEmbeddingConfigReference(instance, [{ kind: "delete_provider", provider: "local" }]);
  assert.equal(fileConfigSchema.parseFromObject(mergeConfigLayers([global, deleted])).context.embedding.model, null);
  assert.throws(() => fileConfigSchema.parseFromObject(mergeConfigLayers([global, { context: { embedding: { model: { model: "partial" } } } }])));
  const renamed = mutateEmbeddingConfigReference(instance, [{ kind: "rename_provider", provider: "local", nextProvider: "new" }]);
  assert.deepEqual(renamed.context.embedding.model, { provider: "new", model: "model" });
  assert.equal(instance.context.embedding.model.provider, "local");
});
