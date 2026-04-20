import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { normalizeTitleForDedup } from "../../src/memory/similarity.ts";
import { PersonaStore } from "../../src/persona/personaStore.ts";
import { SetupStateStore } from "../../src/identity/setupStateStore.ts";
import { createIdentityStore, createMemoryHarness, createMemoryTestConfig } from "../helpers/memory-test-support.tsx";

  test("persona store resets unsupported legacy persona shape and re-enters setup", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-legacy-persona-test-"));
    const config = createMemoryTestConfig();
    const logger = pino({ level: "silent" });
    try {
      await writeFile(join(dataDir, "persona.json"), JSON.stringify({
        virtualAppearance: "旧外貌",
        personality: "旧性格",
        hobbies: "旧爱好",
        likesAndDislikes: "旧喜恶",
        familyBackground: "旧背景",
        speakingStyle: "旧口吻",
        secrets: "旧秘密",
        residence: "旧住处",
        roleplayRequirements: "旧角色要求",
        outputFormatRequirements: "旧输出要求",
        memories: []
      }, null, 2));
      const personaStore = new PersonaStore(dataDir, config, logger);
      const persona = await personaStore.get();
      const setupStore = new SetupStateStore(dataDir, createIdentityStore(true), logger);
      const setupState = await setupStore.init(persona);
      assert.equal(persona.name, "");
      assert.equal(persona.role, "");
      assert.equal(persona.rules, "");
      assert.equal(setupState.state, "needs_persona");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
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
