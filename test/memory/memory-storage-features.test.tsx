import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { normalizeTitleForDedup } from "../../src/memory/similarity.ts";
import { createEmptyPersona, type Persona } from "../../src/persona/personaSchema.ts";
import { PersonaStore } from "../../src/persona/personaStore.ts";
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
        voiceStyle: "简洁"
      };
      assert.equal(personaStore.isComplete(persona), true);
      assert.deepEqual(personaStore.describeMissingFields(persona), []);

      const incomplete: Persona = {
        ...createEmptyPersona(),
        name: "小白",
        temperament: "",
        voiceStyle: ""
      };
      assert.equal(personaStore.isComplete(incomplete), false);
      assert.deepEqual(personaStore.describeMissingFields(incomplete), [
        { key: "temperament", label: "性格底色" },
        { key: "voiceStyle", label: "语气风格" }
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
        identity: "习惯掌控局面，不轻易示弱的独居设计师",
        background: "独居，作息偏晚，日常在工作室和家之间往返",
        continuityFacts: "",
        boundaries: "不跳出当前身份"
      };
      assert.equal(rpStore.isComplete(profile), true);
      assert.deepEqual(rpStore.describeMissingFields(profile), []);

      const incomplete: RpProfile = {
        ...createEmptyRpProfile(),
        identity: "偏克制的搭档",
        background: "",
        continuityFacts: "",
        boundaries: ""
      };
      assert.equal(rpStore.isComplete(incomplete), false);
      assert.deepEqual(rpStore.describeMissingFields(incomplete), [
        { key: "background", label: "稳定背景" },
        { key: "boundaries", label: "边界" }
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  test("rpProfile store persists in state sqlite without legacy json output", async () => {
    const harness = await createMemoryHarness();
    try {
      const rpStore = new RpProfileStore(harness.dataDir, createMemoryTestConfig(), pino({ level: "silent" }));
      const profile: RpProfile = {
        ...createEmptyRpProfile(),
        identity: "偏克制的搭档",
        background: "夜间工作",
        continuityFacts: "",
        boundaries: "不跳出身份"
      };
      await rpStore.write(profile);
      assert.deepEqual(await rpStore.get(), profile);
      await assert.rejects(access(join(harness.dataDir, "rp-profile.json")), /ENOENT/u);
    } finally {
      await harness.cleanup();
    }
  });

  test("state sqlite migrates legacy global profile tables into the reduced field model", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-profile-schema-migration-test-"));
    try {
      const stateDir = join(dataDir, "state");
      await mkdir(stateDir, { recursive: true });
      const db = new Database(join(stateDir, "state.sqlite"));
      try {
        db.exec(`
          CREATE TABLE __sqlite_schema_groups (
            group_id TEXT PRIMARY KEY,
            schema_version INTEGER NOT NULL,
            owned_tables_json TEXT NOT NULL,
            owned_indexes_json TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_reset_at INTEGER,
            last_reset_reason TEXT
          );
          CREATE TABLE persona (
            id TEXT PRIMARY KEY CHECK (id = 'global'),
            name TEXT NOT NULL DEFAULT '',
            temperament TEXT NOT NULL DEFAULT '',
            speaking_style TEXT NOT NULL DEFAULT '',
            global_traits TEXT NOT NULL DEFAULT '',
            general_preferences TEXT NOT NULL DEFAULT '',
            updated_at_ms INTEGER NOT NULL
          );
          CREATE TABLE rp_profile (
            id TEXT PRIMARY KEY CHECK (id = 'global'),
            self_positioning TEXT NOT NULL DEFAULT '',
            social_role TEXT NOT NULL DEFAULT '',
            life_context TEXT NOT NULL DEFAULT '',
            physical_presence TEXT NOT NULL DEFAULT '',
            reality_contract TEXT NOT NULL DEFAULT '',
            continuity_facts TEXT NOT NULL DEFAULT '',
            hard_limits TEXT NOT NULL DEFAULT '',
            updated_at_ms INTEGER NOT NULL
          );
          CREATE TABLE scenario_profile (
            id TEXT PRIMARY KEY CHECK (id = 'global'),
            theme TEXT NOT NULL DEFAULT '',
            host_style TEXT NOT NULL DEFAULT '',
            world_baseline TEXT NOT NULL DEFAULT '',
            safety_or_taboo_rules TEXT NOT NULL DEFAULT '',
            opening_pattern TEXT NOT NULL DEFAULT '',
            updated_at_ms INTEGER NOT NULL
          );
        `);
        db.prepare(`
          INSERT INTO __sqlite_schema_groups (
            group_id, schema_version, owned_tables_json, owned_indexes_json, created_at, updated_at
          )
          VALUES (?, 1, ?, '[]', 1, 1)
        `).run("state.persona", JSON.stringify(["persona"]));
        db.prepare(`
          INSERT INTO __sqlite_schema_groups (
            group_id, schema_version, owned_tables_json, owned_indexes_json, created_at, updated_at
          )
          VALUES (?, 1, ?, '[]', 1, 1)
        `).run("state.rp_profile", JSON.stringify(["rp_profile"]));
        db.prepare(`
          INSERT INTO __sqlite_schema_groups (
            group_id, schema_version, owned_tables_json, owned_indexes_json, created_at, updated_at
          )
          VALUES (?, 1, ?, '[]', 1, 1)
        `).run("state.scenario_profile", JSON.stringify(["scenario_profile"]));
        db.prepare(`
          INSERT INTO persona (
            id, name, temperament, speaking_style, global_traits, general_preferences, updated_at_ms
          )
          VALUES ('global', '小满', '冷静', '短句', '可靠', '少废话', 10)
        `).run();
        db.prepare(`
          INSERT INTO rp_profile (
            id, self_positioning, social_role, life_context, physical_presence,
            reality_contract, continuity_facts, hard_limits, updated_at_ms
          )
          VALUES ('global', '克制', '图书管理员', '夜间工作', '短发', '真人自处', '记得旧约定', '不跳出角色', 11)
        `).run();
        db.prepare(`
          INSERT INTO scenario_profile (
            id, theme, host_style, world_baseline, safety_or_taboo_rules, opening_pattern, updated_at_ms
          )
          VALUES ('global', '都市怪谈', '冷静旁白', '现代都市', '避免过度血腥', '从异响开场', 12)
        `).run();
      } finally {
        db.close();
      }

      const logger = pino({ level: "silent" });
      const config = createMemoryTestConfig();
      const personaStore = new PersonaStore(dataDir, config, logger);
      await personaStore.init();
      const persona = await personaStore.get();
      const rpProfile = await new RpProfileStore(dataDir, config, logger).get();
      const scenarioProfile = await new ScenarioProfileStore(dataDir, config, logger).get();

      assert.deepEqual(persona, {
        name: "小满",
        temperament: "冷静",
        voiceStyle: "短句"
      });
      assert.deepEqual(rpProfile, {
        identity: "克制；图书管理员",
        background: "夜间工作；短发",
        continuityFacts: "记得旧约定",
        boundaries: "不跳出角色；真人自处"
      });
      assert.deepEqual(scenarioProfile, {
        theme: "都市怪谈",
        worldBaseline: "现代都市",
        narrationStyle: "冷静旁白；从异响开场",
        boundaries: "避免过度血腥"
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("profile stores ignore existing legacy json files", async () => {
    const harness = await createMemoryHarness();
    try {
      await writeFile(join(harness.dataDir, "rp-profile.json"), JSON.stringify({
        background: "legacy",
        continuityFacts: "legacy",
        boundaries: "legacy"
      }), "utf8");
      await writeFile(join(harness.dataDir, "scenario-profile.json"), JSON.stringify({
        theme: "legacy",
        narrationStyle: "legacy",
        worldBaseline: "legacy",
        boundaries: "legacy"
      }), "utf8");
      await writeFile(join(harness.dataDir, "global-profile-readiness.json"), JSON.stringify({
        persona: "ready",
        rp: "ready",
        scenario: "ready",
        updatedAt: 1
      }), "utf8");
      await writeFile(join(harness.dataDir, "setup-state.json"), JSON.stringify({
        state: "ready",
        ownerPromptSentAt: null,
        updatedAt: 1
      }), "utf8");

      const rpStore = new RpProfileStore(harness.dataDir, createMemoryTestConfig(), pino({ level: "silent" }));
      const scenarioStore = new ScenarioProfileStore(harness.dataDir, createMemoryTestConfig(), pino({ level: "silent" }));
      const readinessStore = new GlobalProfileReadinessStore(harness.dataDir, createMemoryTestConfig(), pino({ level: "silent" }));
      const setupStore = new SetupStateStore(harness.dataDir, createMemoryTestConfig(), harness.userIdentityStore, pino({ level: "silent" }));

      assert.deepEqual(await rpStore.get(), createEmptyRpProfile());
      assert.deepEqual(await scenarioStore.get(), createEmptyScenarioProfile());
      const readiness = await readinessStore.get();
      assert.equal(readiness.persona, "uninitialized");
      assert.equal(readiness.rp, "uninitialized");
      assert.equal(readiness.scenario, "uninitialized");
      assert.equal((await setupStore.get()).state, "needs_persona");
    } finally {
      await harness.cleanup();
    }
  });

  test("scenarioProfile completeness depends on theme narrationStyle and worldBaseline", async () => {
    const harness = await createMemoryHarness();
    try {
      const scenarioStore = new ScenarioProfileStore(harness.dataDir, createMemoryTestConfig(), pino({ level: "silent" }));
      const profile: ScenarioProfile = {
        ...createEmptyScenarioProfile(),
        theme: "赛博港口",
        narrationStyle: "旁白式主持",
        worldBaseline: "默认世界有基础秩序与明确规则",
        boundaries: ""
      } as ScenarioProfile;
      assert.equal(scenarioStore.isComplete(profile), true);
      assert.deepEqual(scenarioStore.describeMissingFields(profile), []);

      const incomplete: ScenarioProfile = {
        ...createEmptyScenarioProfile(),
        theme: "",
        narrationStyle: "沉浸式主持",
        worldBaseline: "",
        boundaries: "避免暴力描写"
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

  test("scenarioProfile store persists in state sqlite without legacy json output", async () => {
    const harness = await createMemoryHarness();
    try {
      const scenarioStore = new ScenarioProfileStore(harness.dataDir, createMemoryTestConfig(), pino({ level: "silent" }));
      const profile: ScenarioProfile = {
        ...createEmptyScenarioProfile(),
        theme: "赛博港口",
        narrationStyle: "旁白式主持",
        worldBaseline: "默认世界有基础秩序与明确规则",
        boundaries: ""
      };
      await scenarioStore.write(profile);
      assert.deepEqual(await scenarioStore.get(), profile);
      await assert.rejects(access(join(harness.dataDir, "scenario-profile.json")), /ENOENT/u);
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
      await assert.rejects(access(join(harness.dataDir, "global-profile-readiness.json")), /ENOENT/u);
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
      await assert.rejects(access(join(harness.dataDir, "setup-state.json")), /ENOENT/u);
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

  test("user store persists in state sqlite without legacy json output", async () => {
    const harness = await createMemoryHarness();
    try {
      const updated = await harness.userStore.patchUserProfile({
        userId: "10001",
        preferredAddress: "小王",
        occupation: "产品经理"
      });
      assert.equal(updated.preferredAddress, "小王");
      assert.equal((await harness.userStore.getByUserId("10001"))?.occupation, "产品经理");
      await assert.rejects(access(join(harness.dataDir, "users.json")), /ENOENT/u);
    } finally {
      await harness.cleanup();
    }
  });

  test("user store ignores existing legacy users json", async () => {
    const harness = await createMemoryHarness();
    try {
      await writeFile(join(harness.dataDir, "users.json"), JSON.stringify([{
        userId: "legacy-user",
        preferredAddress: "旧用户",
        memories: [],
        createdAt: 1
      }]), "utf8");
      assert.equal(await harness.userStore.getByUserId("legacy-user"), null);
      assert.deepEqual(await harness.userStore.list(), []);
    } finally {
      await harness.cleanup();
    }
  });

  test("user row creation rejects duplicates without replacing memories", async () => {
    const harness = await createMemoryHarness();
    try {
      await harness.userStore.createPersistedRow({
        userId: "10001",
        preferredAddress: "小王"
      });
      await harness.userStore.upsertMemory({
        userId: "10001",
        title: "饮食",
        content: "喜欢拉面"
      });
      await assert.rejects(
        () => harness.userStore.createPersistedRow({
          userId: "10001",
          preferredAddress: "覆盖"
        }),
        /already exists/u
      );
      const stored = await harness.userStore.getByUserId("10001");
      assert.equal(stored?.preferredAddress, "小王");
      assert.equal(stored?.memories.length, 1);
      assert.equal(stored?.memories[0]?.content, "喜欢拉面");
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
    assert.equal(normalizeTitleForDedup("语气风格"), "说话口吻");
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
