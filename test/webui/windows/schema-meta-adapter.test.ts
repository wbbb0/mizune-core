import test from "node:test";
import assert from "node:assert/strict";
import { s } from "../../../src/data/schema/index.ts";
import { schemaMetaToDialogFields } from "../../../webui/src/components/workbench/windows/dialogSchemaAdapter.ts";

test("schemaMetaToDialogFields converts supported object fields", () => {
  const meta = s.object({
    title: s.string().title("标题"),
    pinned: s.boolean().title("置顶").default(false),
    mode: s.enum(["chat", "agent"] as const).title("模式").default("chat"),
    profile: s.object({
      alias: s.string().title("别名"),
      enabled: s.boolean().title("启用")
    }).title("资料")
  }).toMeta();

  const fields = schemaMetaToDialogFields(meta);

  assert.deepEqual(
    fields.map((field) => ({ kind: field.kind, key: field.key })),
    [
      { kind: "string", key: "title" },
      { kind: "boolean", key: "pinned" },
      { kind: "enum", key: "mode" },
      { kind: "group", key: "profile" }
    ]
  );

  const groupField = fields[3];
  assert.ok(groupField);
  assert.equal(groupField.kind, "group");
  assert.equal(groupField.label, "资料");
  assert.deepEqual(
    groupField.fields.map((field: { kind: string; key: string }) => ({ kind: field.kind, key: field.key })),
    [
      { kind: "string", key: "alias" },
      { kind: "boolean", key: "enabled" }
    ]
  );

  const modeField = fields[2];
  assert.ok(modeField);
  assert.equal(modeField.kind, "enum");
  assert.deepEqual(modeField.options, [
    { label: "chat", value: "chat" },
    { label: "agent", value: "agent" }
  ]);
});

test("schemaMetaToDialogFields rejects unsupported schema kinds", () => {
  const metas = [
    s.record(s.string(), s.string()).toMeta(),
    s.array(s.string()).toMeta(),
    s.union([s.string(), s.number()]).toMeta(),
    s.literal("fixed").toMeta()
  ];

  for (const meta of metas) {
    assert.throws(
      () => schemaMetaToDialogFields(meta),
      /unsupported schema meta/i
    );
  }
});
