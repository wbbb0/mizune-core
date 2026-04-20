import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryHarness } from "../helpers/memory-test-support.tsx";

  test("global rules support upsert and removal", async () => {
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

  test("global rules support overwrite list semantics", async () => {
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

  test("global rules upsert updates a near-duplicate existing row", async () => {
    const harness = await createMemoryHarness();
    try {
      const created = await harness.globalRuleStore.upsert({
        title: "输出顺序",
        content: "先给结论，再补细节"
      });
      const updated = await harness.globalRuleStore.upsert({
        title: "回答顺序",
        content: "先给结论，再补充细节"
      });
      assert.equal(updated.action, "updated_existing");
      assert.equal(updated.finalAction, "updated_existing");
      assert.equal(updated.dedup.matchedBy, "near_duplicate");
      assert.equal(updated.dedup.matchedExistingId, created.item.id);
      assert.equal(typeof updated.dedup.similarityScore, "number");
      const listed = await harness.globalRuleStore.getAll();
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, created.item.id);
    } finally {
      await harness.cleanup();
    }
  });

  test("global rule writes log similarity metadata and reroute diagnostics", async () => {
    const loggerEvents: Array<{ level: "info" | "warn"; event: string; payload: Record<string, unknown> }> = [];
    const logger = {
      info(payload: Record<string, unknown>, event: string) {
        loggerEvents.push({ level: "info", event, payload });
      },
      warn(payload: Record<string, unknown>, event: string) {
        loggerEvents.push({ level: "warn", event, payload });
      }
    };
    const harness = await createMemoryHarness({ logger });
    try {
      const created = await harness.globalRuleStore.upsert({
        title: "输出顺序",
        content: "先给结论，再补细节"
      });
      const updated = await harness.globalRuleStore.upsert({
        title: "回答顺序",
        content: "先给结论，再补充细节"
      });
      const warned = await harness.globalRuleStore.upsert({
        title: "角色口吻",
        content: "以后都用傲娇少女口吻说话"
      });
      assert.ok(created.item.id);
      assert.equal(typeof updated.dedup.similarityScore, "number");
      assert.equal(warned.warning?.suggestedScope, "persona");

      const upsertLogs = loggerEvents.filter((item) => item.event === "global_rule_upserted");
      assert.equal(upsertLogs.length, 3);
      assert.equal(upsertLogs[1]?.payload.dedupMatchedBy, "near_duplicate");
      assert.equal(upsertLogs[1]?.payload.dedupMatchedExistingId, created.item.id);
      assert.equal(typeof upsertLogs[1]?.payload.dedupSimilarityScore, "number");
      assert.equal(upsertLogs[2]?.payload.rerouteResult, "not_rerouted_scope_warning");
      assert.equal(upsertLogs[2]?.payload.rerouteSuggestedScope, "persona");
    } finally {
      await harness.cleanup();
    }
  });
