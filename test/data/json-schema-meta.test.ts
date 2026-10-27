import test from "node:test";
import assert from "node:assert/strict";
import { jsonSchemaToMeta } from "../../src/data/schema/jsonSchemaMeta.ts";
import { buildUiTreeFromMeta } from "../../src/data/schema/ui.ts";
import { personaJsonSchema, socialJsonSchema, embodimentJsonSchema, simulationJsonSchema } from "../../src/character/schemaCatalog.ts";

test("角色 JSON Schema 可转换完整树，保留 nullable、枚举、数值边界和集合", () => {
  for (const schema of [personaJsonSchema, socialJsonSchema, embodimentJsonSchema, simulationJsonSchema]) {
    assert.equal(buildUiTreeFromMeta(jsonSchemaToMeta(schema)).kind, "group");
  }
  const nullable = jsonSchemaToMeta({ type: ["integer", "null"], minimum: 0, maximum: 100 });
  assert.equal(nullable.kind, "union");
  if (nullable.kind !== "union") return;
  assert.deepEqual(nullable.options[0]!, { kind: "number", integer: true, min: 0, max: 100, optional: false, hasDefault: true, defaultValue: 0 });
  assert.equal(nullable.options[1]!.kind, "literal");
  const tree = buildUiTreeFromMeta(jsonSchemaToMeta({ type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "string", enum: ["a", "b"] } } } }));
  assert.equal(tree.kind, "group");
  if (tree.kind !== "group") return;
  assert.equal(tree.children.items!.node.kind, "array");
  assert.equal(tree.children.items!.field.schema.optional, false);
});

test("nullable 枚举分开非空选项和 null，防止选择空值写入字符串 null", () => {
  const meta = jsonSchemaToMeta({ type: ["string", "null"], enum: ["clothing", "accessory", null] });
  assert.equal(meta.kind, "union");
  if (meta.kind !== "union") return;
  assert.equal(meta.options[0]!.kind, "enum");
  if (meta.options[0]!.kind === "enum") assert.deepEqual(meta.options[0]!.values, ["clothing", "accessory"]);
  assert.deepEqual(meta.options[1]!, { kind: "literal", value: null, optional: false, hasDefault: true, defaultValue: null });
});

test("启用可空对象和新增集合条目具有完整必填空结构", () => {
  const root = jsonSchemaToMeta(embodimentJsonSchema);
  assert.equal(root.kind, "object");
  if (root.kind !== "object") return;
  const physiology = root.fields.physiology!.schema;
  if (physiology.kind !== "object") return assert.fail("physiology object");
  const cycle = physiology.fields.menstrualCycle!.schema;
  if (cycle.kind !== "union") return assert.fail("nullable cycle");
  assert.deepEqual(cycle.options[0]!.defaultValue, { mode: "disabled", reason: null, parameters: { cycleDays: null, maxVariationDays: null, durationDays: null }, narrativeRules: null });
  assert.equal(cycle.defaultValue, null);
});
