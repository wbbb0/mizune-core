import test from "node:test";
import assert from "node:assert/strict";
import { buildToolHintLines } from "../../src/llm/prompt/promptToolHints.ts";

test("model self-upgrade hint defines both checkpoints and excludes unrelated limitations", () => {
  const text = buildToolHintLines(["request_model_upgrade"]).join("\n");

  assert.match(text, /收到任务后、展开详细推理前/);
  assert.match(text, /关键工具结果暴露此前未知的复杂约束或风险/);
  assert.match(text, /无需先尝试完整解题或证明自己做不到/);
  assert.match(text, /机械步骤多、回答较长、普通不确定、缺少工具、权限或外部事实都不是升级理由/);
  assert.match(text, /升级属于内部路由，不向用户提及/);
});
