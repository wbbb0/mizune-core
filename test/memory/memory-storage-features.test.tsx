import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { normalizeTitleForDedup } from "../../src/memory/similarity.ts";
import { createEmptyPersona, type Persona } from "../../src/persona/personaSchema.ts";
import { type GlobalProfileReadiness } from "../../src/identity/globalProfileReadinessSchema.ts";
import { GlobalProfileReadinessStore } from "../../src/identity/globalProfileReadinessStore.ts";
import { SetupStateStore } from "../../src/identity/setupStateStore.ts";
import { RpProfileStore } from "../../src/modes/rpAssistant/profileStore.ts";
import { createEmptyRpProfile, type RpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { ScenarioProfileStore } from "../../src/modes/scenarioHost/profileStore.ts";
import {
  createEmptyScenarioProfile,
  type ScenarioProfile
} from "../../src/modes/scenarioHost/profileSchema.ts";
import { createIdentityStore, createMemoryHarness, createMemoryTestConfig } from "../helpers/memory-test-support.tsx";

  test("persona completeness only depends on global persona fields", async () => {
    const harness = await createMemoryHarness();
    try {
      const personaStore = harness.personaStore;
      const persona: Persona = {
        ...createEmptyPersona(),
        name: "小白",
        coreIdentity: "跨任务对话代理",
        personality: "冷静直接",
        speechStyle: "简洁",
        interests: "",
        background: ""
      };
      assert.equal(personaStore.isComplete(persona), true);
      assert.deepEqual(personaStore.describeMissingFields(persona), []);

      const incomplete: Persona = {
        ...createEmptyPersona(),
        name: "小白",
        coreIdentity: "",
        personality: "冷静直接",
        speechStyle: "",
        interests: "阅读",
        background: "本地部署"
      };
      assert.equal(personaStore.isComplete(incomplete), false);
      assert.deepEqual(personaStore.describeMissingFields(incomplete), [
        { key: "coreIdentity", label: "基础身份" },
        { key: "speechStyle", label: "说话方式" }
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test("rpProfile completeness depends on premise identityBoundary and hardRules", async () => {
    const harness = await createMemoryHarness();
    try {
      const rpStore = new RpProfileStore(harness.dataDir, createMemoryTestConfig(), pino({ level: "silent" }));
      const profile: RpProfile = {
        ...createEmptyRpProfile(),
        appearance: "成熟稳重",
        premise: "与 owner 的长期角色扮演协作关系",
        relationship: "",
        identityBoundary: "只扮演设定角色，不越界到用户现实身份",
        styleRules: "",
        hardRules: "不输出越权内容"
      };
      assert.equal(rpStore.isComplete(profile), true);
      assert.deepEqual(rpStore.describeMissingFields(profile), []);

      const incomplete: RpProfile = {
        ...createEmptyRpProfile(),
        appearance: "",
        premise: "长期陪伴",
        relationship: "搭档",
        identityBoundary: "",
        styleRules: "口吻保持克制",
        hardRules: ""
      };
      assert.equal(rpStore.isComplete(incomplete), false);
      assert.deepEqual(rpStore.describeMissingFields(incomplete), [
        { key: "identityBoundary", label: "身份边界" },
        { key: "hardRules", label: "硬规则" }
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test("scenarioProfile completeness depends on theme hostStyle and worldBaseline", async () => {
    const harness = await createMemoryHarness();
    try {
      const scenarioStore = new ScenarioProfileStore(harness.dataDir, createMemoryTestConfig(), pino({ level: "silent" }));
      const profile: ScenarioProfile = {
        ...createEmptyScenarioProfile(),
        theme: "赛博港口",
        hostStyle: "旁白式主持",
        worldBaseline: "默认世界有基础秩序与明确规则",
        safetyOrTabooRules: "",
        openingPattern: ""
      } as ScenarioProfile;
      assert.equal(scenarioStore.isComplete(profile), true);
      assert.deepEqual(scenarioStore.describeMissingFields(profile), []);

      const incomplete: ScenarioProfile = {
        ...createEmptyScenarioProfile(),
        theme: "",
        hostStyle: "沉浸式主持",
        worldBaseline: "",
        safetyOrTabooRules: "避免暴力描写",
        openingPattern: "开场白"
      };
      assert.equal(scenarioStore.isComplete(incomplete), false);
      assert.deepEqual(scenarioStore.describeMissingFields(incomplete), [
        { key: "theme", label: "主题" },
        { key: "worldBaseline", label: "世界基线" }
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test("global profile readiness store can read and write persona rp and scenario readiness", async () => {
    const harness = await createMemoryHarness();
    try {
      const readinessStore = new GlobalProfileReadinessStore(harness.dataDir, createMemoryTestConfig(), pino({ level: "silent" }));
      const initial = await readinessStore.get();
      assert.equal(initial.persona, "uninitialized");
      assert.equal(initial.rp, "uninitialized");
      assert.equal(initial.scenario, "uninitialized");
      assert.equal(typeof initial.updatedAt, "number");

      const next: GlobalProfileReadiness = {
        persona: "ready",
        rp: "ready",
        scenario: "ready",
        updatedAt: 1234567890
      };
      await readinessStore.write(next);
      assert.deepEqual(await readinessStore.get(), next);
      assert.equal(await readinessStore.isPersonaReady(), true);
      assert.equal(await readinessStore.isRpReady(), true);
      assert.equal(await readinessStore.isScenarioReady(), true);
    } finally {
      await harness.cleanup();
    }
  });

  test("setup state starts in needs_persona for empty persona", async () => {
    const harness = await createMemoryHarness();
    try {
      const setupStore = new SetupStateStore(harness.dataDir, harness.userIdentityStore, pino({ level: "silent" }));
      const persona = await harness.personaStore.get();
      const state = await setupStore.init(persona);
      assert.equal(state.state, "needs_persona");
      assert.ok(setupStore.describeMissingFields(persona).length > 0);
    } finally {
      await harness.cleanup();
    }
  });

  test("user memories support overwrite list semantics", async () => {
    const harness = await createMemoryHarness();
    try {
      const updated = await harness.userStore.overwriteMemories("10001", [
        { title: "饮食", content: "喜欢拉面" },
        { title: "作息", content: "经常熬夜" }
      ]);
      assert.equal(updated.memories.length, 2);
      const listed = await harness.userStore.getByUserId("10001");
      assert.equal(listed?.memories.length, 2);
      assert.match(JSON.stringify(listed?.memories), /喜欢拉面/);
    } finally {
      await harness.cleanup();
    }
  });

  test("user memory upsert updates a near-duplicate existing row", async () => {
    const harness = await createMemoryHarness();
    try {
      const created = await harness.userStore.upsertMemory({
        userId: "10001",
        title: "称呼偏好",
        content: "希望你叫我老王",
        kind: "preference"
      });
      const updated = await harness.userStore.upsertMemory({
        userId: "10001",
        title: "用户称呼偏好",
        content: "希望你叫我老王",
        kind: "preference"
      });
      assert.equal(updated.action, "updated_existing");
      assert.equal(updated.dedup.matchedBy, "near_duplicate");
      assert.equal(updated.dedup.matchedExistingId, created.item.id);
      assert.equal(typeof updated.dedup.similarityScore, "number");
      const stored = await harness.userStore.getByUserId("10001");
      assert.equal(stored?.memories.length, 1);
      assert.equal(stored?.memories[0]?.id, created.item.id);
    } finally {
      await harness.cleanup();
    }
  });

  test("title normalization canonicalizes recurring memory concepts", async () => {
    assert.equal(normalizeTitleForDedup("称呼"), "称呼偏好");
    assert.equal(normalizeTitleForDedup("用户称呼偏好"), "称呼偏好");
    assert.equal(normalizeTitleForDedup("说话方式"), "说话口吻");
  });

  test("user memory write logs expose dedup similarity and reroute diagnostics", async () => {
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
      const created = await harness.userStore.upsertMemory({
        userId: "10001",
        title: "饮食偏好",
        content: "不喜欢香菜"
      });
      const updated = await harness.userStore.upsertMemory({
        userId: "10001",
        title: "饮食偏好",
        content: "不喜欢香菜"
      });
      const warned = await harness.userStore.upsertMemory({
        userId: "10001",
        title: "叫我",
        content: "以后叫我老王"
      });
      assert.ok(created.item.id);
      assert.equal(typeof updated.dedup.similarityScore, "number");
      assert.equal(warned.warning?.suggestedScope, "user_profile");

      const upsertLogs = loggerEvents.filter((item) => item.event === "user_memory_upserted");
      assert.equal(upsertLogs.length, 3);
      assert.equal(upsertLogs[1]?.payload.dedupMatchedBy, "near_duplicate");
      assert.equal(upsertLogs[1]?.payload.dedupMatchedExistingId, created.item.id);
      assert.equal(typeof upsertLogs[1]?.payload.dedupSimilarityScore, "number");
      assert.equal(upsertLogs[1]?.payload.rerouteResult, "not_applicable");
      assert.equal(upsertLogs[2]?.payload.rerouteResult, "not_rerouted_scope_warning");
      assert.equal(upsertLogs[2]?.payload.rerouteSuggestedScope, "user_profile");
    } finally {
      await harness.cleanup();
    }
  });
