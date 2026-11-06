import test from "node:test";
import assert from "node:assert/strict";
import { s } from "../../src/data/schema/index.ts";
import { buildUiTree } from "../../src/data/schema/ui.ts";
import { llmCatalogFileSchema } from "../../src/config/configModel.ts";

test("无固定字段的开放对象使用 JSON 字段，保持完整校验元信息", () => {
  const schema = s.object({}).passthrough().title("自由参数").optional();
  const node = buildUiTree(schema);
  assert.equal(node.kind, "field");
  assert.deepEqual(node.schema, schema.toMeta());
  const nested = buildUiTree(s.object({ settings: schema }));
  if (nested.kind !== "group") return assert.fail("object group");
  assert.equal(nested.children.settings!.node.kind, "field");
});

test("严格空对象和有声明字段的开放对象保留分组，避免影响空用途配置", () => {
  for (const schema of [s.object({}).strict(), s.object({}), s.object({ key: s.string() }).passthrough()]) {
    assert.equal(buildUiTree(schema).kind, "group");
  }
  const tree = buildUiTree(llmCatalogFileSchema);
  if (tree.kind !== "record" || tree.value.kind !== "union") return assert.fail("catalog tree");
  const provider = tree.value.options.find(option => option.kind === "group" && option.children.type?.node.schema.kind === "literal" && option.children.type.node.schema.value === "openai");
  if (provider?.kind !== "group") return assert.fail("OpenAI branch");
  const models = provider.children.models!.node;
  if (models.kind !== "record" || models.value.kind !== "group") return assert.fail("model entry");
  assert.equal(models.value.children.decision!.node.kind, "group");
  const chat = models.value.children.chat!.node;
  if (chat.kind !== "group") return assert.fail("chat group");
  const defaults = chat.children.defaults!.node;
  if (defaults.kind !== "group") return assert.fail("defaults group");
  assert.equal(defaults.children.extra!.node.kind, "field");
});
