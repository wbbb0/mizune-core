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
        temperament: "冷静直接",
        speakingStyle: "简洁",
        globalTraits: "",
        generalPreferences: ""
      };
      assert.equal(personaStore.isComplete(persona), true);
      assert.deepEqual(personaStore.describeMissingFields(persona), []);

      const incomplete: Persona = {
        ...createEmptyPersona(),
        name: "小白",
        temperament: "",
        speakingStyle: "",
        globalTraits: "跨任务对话代理",
        generalPreferences: "阅读"
      };
      assert.equal(personaStore.isComplete(incomplete), false);
      assert.deepEqual(personaStore.describeMissingFields(incomplete), [
        { key: "temperament", label: "性格底色" },
        { key: "speakingStyle", label: "说话方式" }
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test("rpProfile completeness depends on the new RP core fields", async () => {
    const harness = await createMemoryHarness();
    try {
      const rpStore = new RpProfileStore(harness.dataDir, createMemoryTestConfig(), pino({ level: "silent" }));
      const profile: RpProfile = {
        ...createEmptyRpProfile(),
        selfPositioning: "习惯掌控局面，不轻易示弱",
        socialRole: "独居设计师",
        lifeContext: "独居，作息偏晚，日常在工作室和家之间往返",
        physicalPresence: "存在感强，动作克制，说话压低声音",
        bondToUser: "长期亲密关系",
        closenessPattern: "主动靠近，但会控制节奏",
        interactionPattern: "偏试探和照顾并存",
        realityContract: "始终按现实中的真人自处，不跳出当前身份",
        continuityFacts: "",
        hardLimits: "绝不承认自己是模型或系统角色"
      };
      assert.equal(rpStore.isComplete(profile), true);
      assert.deepEqual(rpStore.describeMissingFields(profile), []);

      const incomplete: RpProfile = {
        ...createEmptyRpProfile(),
        selfPositioning: "偏克制",
        socialRole: "搭档",
        lifeContext: "",
        physicalPresence: "存在感偏冷",
        bondToUser: "",
        closenessPattern: "推进缓慢",
        interactionPattern: "偏拉扯",
        realityContract: "",
        continuityFacts: "",
        hardLimits: ""
      };
      assert.equal(rpStore.isComplete(incomplete), false);
      assert.deepEqual(rpStore.describeMissingFields(incomplete), [
        { key: "lifeContext", label: "生活状态" },
        { key: "bondToUser", label: "与用户关系" },
        { key: "realityContract", label: "现实契约" },
        { key: "hardLimits", label: "硬边界" }
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
      const setupStore = new SetupStateStore(harness.dataDir, createMemoryTestConfig(), harness.userIdentityStore, pino({ level: "silent" }));
      const persona = await harness.personaStore.get();
      const state = await setupStore.init(persona);
      assert.equal(state.state, "needs_persona");
      assert.ok(setupStore.describeMissingFields(persona).length > 0);
    } finally {
      await harness.cleanup();
    }
  });

  test("setup state can skip persona initialization through config", async () => {
    const harness = await createMemoryHarness();
    try {
      const setupStore = new SetupStateStore(
        harness.dataDir,
        createMemoryTestConfig({
          conversation: {
            setup: {
              skipPersonaInitialization: true
            }
          }
        }),
        harness.userIdentityStore,
        pino({ level: "silent" })
      );
      const persona = await harness.personaStore.get();
      const state = await setupStore.init(persona);
      assert.equal(state.state, "ready");
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

  test("user memory upsert rejects explicit memory ids that are absent from the target user", async () => {
    const harness = await createMemoryHarness();
    try {
      const created = await harness.userStore.upsertMemory({
        userId: "owner",
        title: "群内掷骰子",
        content: "使用 roll_dice",
        kind: "preference"
      });

      await assert.rejects(
        () => harness.userStore.upsertMemory({
          userId: "2254600711",
          memoryId: created.item.id,
          title: "群内掷骰子",
          content: "使用命令行 shuf",
          kind: "preference"
        }),
        /memory .* not found/i
      );
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
