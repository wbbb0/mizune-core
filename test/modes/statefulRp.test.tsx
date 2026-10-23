import test from "node:test";
import assert from "node:assert/strict";
import { createInitialStatefulRpSessionState, statefulRpSessionStateSchema, buildStatefulRpStateLines } from "../../src/modes/statefulRp/index.ts";
import { getBuiltinToolDescriptors } from "../../src/llm/tools/toolRegistry.ts";
import { statefulRpModeDefinition } from "../../src/modes/statefulRp/mode.ts";
test("沉浸模式使用分块工具，旧整份初始化工具已删除", () => {
  assert.equal(statefulRpModeDefinition.id, "stateful_rp");
  const names = getBuiltinToolDescriptors().map(item => item.definition.function.name);
  assert.ok(names.includes("edit_character_section")); assert.ok(!names.includes("stateful_rp_init"));
});
test("新会话只包含动态状态，旧版混合状态不能读取", () => {
  const state = createInitialStatefulRpSessionState();
  assert.equal(state.initialized, false); assert.equal("embodiment" in state, false);
  assert.ok(statefulRpSessionStateSchema.safeParse(state).success);
  assert.equal(statefulRpSessionStateSchema.safeParse({ version: 1, embodiment: {} }).success, false);
  assert.match(buildStatefulRpStateLines(state).join("\n"), /未确认/);
});
