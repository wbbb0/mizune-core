import assert from "node:assert/strict";
import { createMemoryHarness, runCase } from "../helpers/memory-test-support.tsx";

async function main() {
  await runCase("global rules support upsert and removal", async () => {
    const harness = await createMemoryHarness();
    try {
      const created = await harness.globalRuleStore.upsert({
        title: "任务默认格式",
        content: "先给结论，再补充细节"
      });
      assert.equal(created.rules.length, 1);
      assert.equal(created.action, "created");
      const ruleId = created.item.id;
      assert.ok(ruleId);

      const updated = await harness.globalRuleStore.upsert({
        ruleId,
        title: "任务默认格式",
        content: "先给结论，再给步骤"
      });
      assert.equal(updated.rules.length, 1);
      assert.equal(updated.action, "updated_existing");
      assert.match(updated.item.content, /先给结论/);

      const listed = await harness.globalRuleStore.getAll();
      assert.equal(listed.length, 1);

      const removed = await harness.globalRuleStore.remove(ruleId);
      assert.equal(removed.length, 0);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("global rules support overwrite list semantics", async () => {
    const harness = await createMemoryHarness();
    try {
      const updated = await harness.globalRuleStore.overwrite([
        { title: "查资料规则", content: "优先给来源" },
        { title: "输出风格", content: "先结论后分析" }
      ]);
      assert.equal(updated.length, 2);
      const listed = await harness.globalRuleStore.list();
      assert.equal(listed.length, 2);
      assert.match(JSON.stringify(listed), /优先给来源/);
    } finally {
      await harness.cleanup();
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
