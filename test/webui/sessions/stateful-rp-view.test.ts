import test from "node:test";
import assert from "node:assert/strict";
import { socialStateSchema, simulationStateSchema, scalarText, schemaEntries, type StateSchema } from "../../../webui/src/components/sessions/statefulRpView.ts";

test("动态状态展示覆盖 Schema 分区和可空嵌套集合，不依赖 JSON 原文", () => {
  assert.deepEqual(Object.keys(simulationStateSchema.properties!), ["initialized", "clock", "scene", "body", "mind", "relationships", "schedule", "wardrobe", "journal"]);
  function walk(schema: StateSchema) {
    assert.equal(schema.$ref, undefined);
    for (const child of Object.values(schema.properties ?? {})) walk(child);
    if (schema.items) walk(schema.items);
  }
  walk(simulationStateSchema);
  walk(socialStateSchema);
  assert.equal(scalarText(null), "未指定");
  assert.equal(scalarText(false), "否");
  assert.equal(scalarText(0), "0");
  assert.equal(scalarText("pending", { enum: ["pending"] }), "待完成");
  assert.equal(scalarText("pending"), "pending");
  const entries = schemaEntries({ currentMood: "平静", promises: [] }, socialStateSchema);
  assert.equal(entries.find(row => row.key === "currentMood")!.label, "当前心情");
  assert.deepEqual(entries.find(row => row.key === "promises")!.value, []);
  assert.equal(entries.length, Object.keys(socialStateSchema.properties!).length);
});
