import assert from "node:assert/strict";
import { createMemoryHarness, runCase } from "./helpers/memory-test-support.tsx";

async function main() {
  await runCase("global memories support upsert and removal", async () => {
    const harness = await createMemoryHarness();
    try {
      const created = await harness.globalMemoryStore.upsert({
        title: "任务默认格式",
        content: "先给结论，再补充细节"
      });
      assert.equal(created.length, 1);
      const memoryId = created[0]?.id ?? "";
      assert.ok(memoryId);

      const updated = await harness.globalMemoryStore.upsert({
        memoryId,
        title: "任务默认格式",
        content: "先给结论，再给步骤"
      });
      assert.equal(updated.length, 1);
      assert.match(updated[0]?.content ?? "", /先给结论/);

      const listed = await harness.globalMemoryStore.getAll();
      assert.equal(listed.length, 1);

      const removed = await harness.globalMemoryStore.remove(memoryId);
      assert.equal(removed.length, 0);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("global memories support overwrite list semantics", async () => {
    const harness = await createMemoryHarness();
    try {
      const updated = await harness.globalMemoryStore.overwrite([
        { title: "查资料规则", content: "优先给来源" },
        { title: "输出风格", content: "先结论后分析" }
      ]);
      assert.equal(updated.length, 2);
      const listed = await harness.globalMemoryStore.list();
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
