import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describeModelRouteType, describePlannerModelSelection } from "../../../webui/src/components/sessions/plannerPresentation.ts";
import type { TranscriptItem } from "../../../webui/src/api/types.ts";

type Gate = Extract<TranscriptItem, { kind: "gate_decision" }>;
const gate: Gate = {
  id: "gate-1", groupId: "response-1", runtimeExcluded: false,
  kind: "gate_decision", llmVisible: false, action: "continue", reason: null, timestampMs: 1
};

test("planner presentation does not label an undetermined model as a confirmed small or large model", () => {
  assert.equal(describePlannerModelSelection({ ...gate, modelTier: "small", modelSelectionStatus: "undetermined" }), "未判定");
  assert.equal(describePlannerModelSelection({ ...gate, modelTier: "large", modelSelectionStatus: "undetermined" }), "未判定");
  assert.equal(describePlannerModelSelection({ ...gate, modelTier: "large", modelSelectionStatus: "decided" }), "大模型");
  assert.equal(describePlannerModelSelection({ ...gate, modelTier: "small", modelSelectionStatus: "decided" }), "小模型");
  assert.equal(describePlannerModelSelection({ ...gate, modelSelectionStatus: "not_requested" }), "本轮未请求选模");
  assert.equal(describePlannerModelSelection(gate), null);
});

test("policy routing states have distinct user-visible labels", () => {
  assert.equal(describeModelRouteType("self_upgrade"), "自助升级");
  assert.equal(describeModelRouteType("policy_upgrade"), "策略升级");
  assert.equal(describeModelRouteType("policy_unavailable"), "无法升级");
});

test("session transcript renders task basis and actual policy call origin", async () => {
  const source = await readFile(new URL("../../../webui/src/components/sessions/TranscriptItem.vue", import.meta.url), "utf8");
  assert.match(source, /v-if="item\.taskBasis" title="任务依据"/);
  assert.match(source, /:text="item\.taskBasis"/);
  assert.match(source, /describePlannerModelSelection\(props\.item\)/);
  assert.match(source, /item\.sourceModelRef/);
  assert.match(source, /无可用候选/);
  assert.match(source, /尚未执行/);
});
