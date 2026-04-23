import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryHarness } from "../helpers/memory-test-support.tsx";

  test("user profile patch keeps structured extended fields and compacts profile summary", async () => {
    const harness = await createMemoryHarness();
    try {
      const updated = await harness.userStore.patchUserProfile({
        userId: "10001",
        preferredAddress: " 小王 ",
        timezone: " Asia/Shanghai ",
        occupation: " 产品经理 ",
        profileSummary: "做事很快。\n经常先给结论。喜欢把问题拆开处理。这个补充应该被裁短。"
      });
      assert.equal(updated.preferredAddress, "小王");
      assert.equal(updated.timezone, "Asia/Shanghai");
      assert.equal(updated.occupation, "产品经理");
      assert.ok(updated.profileSummary);
      assert.ok(updated.profileSummary.length <= 120);
      assert.doesNotMatch(updated.profileSummary, /\n/);
      assert.match(updated.profileSummary, /做事很快；经常先给结论/);
    } finally {
      await harness.cleanup();
    }
  });

  test("user memory writes infer concrete kinds for preferences and boundaries", async () => {
    const harness = await createMemoryHarness();
    try {
      const preference = await harness.userStore.upsertMemory({
        userId: "10001",
        title: "饮食偏好",
        content: "不喜欢香菜"
      });
      const boundary = await harness.userStore.upsertMemory({
        userId: "10001",
        title: "交流边界",
        content: "不要替我做决定"
      });
      assert.equal(preference.item.kind, "preference");
      assert.equal(boundary.item.kind, "boundary");
    } finally {
      await harness.cleanup();
    }
  });

  test("persona patch diagnostics warn when workflow defaults are written into persona rules", async () => {
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
      const result = await harness.personaStore.patchWithDiagnostics({
        speakingStyle: "所有任务默认先给结论再展开。"
      });
      assert.equal(result.warning?.suggestedScope, "global_rules");
      const updateLog = loggerEvents.find((item) => item.event === "persona_updated");
      assert.equal(updateLog?.payload.finalAction, "warning_scope_conflict");
      assert.equal(updateLog?.payload.rerouteResult, "not_rerouted_scope_warning");
      assert.equal(updateLog?.payload.rerouteSuggestedScope, "global_rules");
    } finally {
      await harness.cleanup();
    }
  });

  test("persona identity and speech-style updates stay in persona without workflow warnings", async () => {
    const harness = await createMemoryHarness();
    try {
      const result = await harness.personaStore.patchWithDiagnostics({
        globalTraits: "嘴硬但靠谱的搭档",
        speakingStyle: "说话直接一点，但别太凶。"
      });
      assert.equal(result.warning, null);
      assert.equal(result.persona.globalTraits, "嘴硬但靠谱的搭档");
      assert.equal(result.persona.speakingStyle, "说话直接一点，但别太凶。");
    } finally {
      await harness.cleanup();
    }
  });

  test("mixed profile-like user memory input returns a profile warning instead of silently storing to the wrong category", async () => {
    const harness = await createMemoryHarness();
    try {
      const result = await harness.userStore.upsertMemory({
        userId: "10001",
        title: "用户资料",
        content: "我住在杭州，也希望你叫我老王"
      });
      assert.equal(result.warning?.suggestedScope, "user_profile");
    } finally {
      await harness.cleanup();
    }
  });

  test("global and toolset rules keep category boundaries at store layer", async () => {
    const harness = await createMemoryHarness();
    try {
      const globalRule = await harness.globalRuleStore.upsert({
        title: "默认输出顺序",
        content: "平时先给结论再展开。"
      });
      const toolsetRule = await harness.toolsetRuleStore.upsert({
        title: "网页登录处理",
        content: "只有遇到网页登录任务时才读取站点凭据。",
        toolsetIds: ["web_research"]
      });
      const leakedToolsetRule = await harness.toolsetRuleStore.upsert({
        title: "通用输出顺序",
        content: "所有任务默认先给结论再展开。",
        toolsetIds: ["web_research"]
      });

      assert.notEqual(globalRule.item.kind, "other");
      assert.equal(globalRule.warning, null);
      assert.equal(toolsetRule.warning, null);
      assert.equal(leakedToolsetRule.warning?.suggestedScope, "global_rules");
    } finally {
      await harness.cleanup();
    }
  });

  test("toolset rule writes log reroute diagnostics for cross-category warnings", async () => {
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
      const result = await harness.toolsetRuleStore.upsert({
        title: "通用输出顺序",
        content: "所有任务默认先给结论再展开。",
        toolsetIds: ["web_research"]
      });
      assert.equal(result.warning?.suggestedScope, "global_rules");
      const upsertLog = loggerEvents.find((item) => item.event === "toolset_rule_upserted");
      assert.equal(upsertLog?.payload.rerouteResult, "not_rerouted_scope_warning");
      assert.equal(upsertLog?.payload.rerouteSuggestedScope, "global_rules");
      assert.equal(upsertLog?.payload.toolsetIds instanceof Array, true);
    } finally {
      await harness.cleanup();
    }
  });
