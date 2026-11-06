import test from "node:test";
import assert from "node:assert/strict";
import { GenerationModelPolicy } from "../../src/app/generation/generationModelPolicy.ts";

const call = (id: string) => ({ id, type: "function" as const, function: { name: "operate", arguments: "{}" } });
const high = { tier: "large" as const, reason: "需要操作真实环境" };

test("升级后同批小模型调用继续延后，只有大模型重新提出的调用获准", () => {
  let upgrades = 0;
  const policy = new GenerationModelPolicy({ largeModelRefs: ["large"], requestUpgrade: () => { upgrades++; return true; } });
  const first = call("first");
  const second = call("second");
  policy.capture([first, second], "small", "small");
  for (const item of [first, second]) {
    const result = JSON.parse(policy.authorize(item, high)!);
    assert.equal(result.executed, false);
    assert.equal(result.deferred, true);
  }
  const repeated = call("replanned");
  policy.capture([repeated], "large", "large");
  assert.equal(policy.authorize(repeated, high), null);
  assert.equal(upgrades, 2);
});

test("实际模型必须属于已配置的大模型候选，不能只相信路由角色", () => {
  const policy = new GenerationModelPolicy({ largeModelRefs: ["large", "large_fallback"], requestUpgrade: () => false });
  const item = call("operation");
  policy.capture([item], "unrelated_fallback", "large");
  assert.equal(JSON.parse(policy.authorize(item, high)!).code, "model_policy_unavailable");
  policy.capture([item], "large_fallback", "large");
  assert.equal(policy.authorize(item, high), null);
});

test("没有已确认来源或无法升级时不执行高影响操作，低影响查询可继续", () => {
  const policy = new GenerationModelPolicy({ largeModelRefs: [], requestUpgrade: () => false });
  const item = call("operation");
  assert.equal(JSON.parse(policy.authorize(item, high)!).executed, false);
  assert.equal(policy.authorize(item, { tier: "small", reason: "读取已有状态" }), null);
});
