import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { PersonaStore } from "../../src/persona/personaStore.ts";
import { SetupStateStore } from "../../src/identity/setupStateStore.ts";
import { createMemoryHarness, createMemoryTestConfig, createWhitelistStore, runCase } from "../helpers/memory-test-support.tsx";

async function main() {
  await runCase("persona store resets unsupported legacy persona shape and re-enters setup", async () => {
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
      const setupStore = new SetupStateStore(dataDir, createWhitelistStore(), logger);
      const setupState = await setupStore.init(persona);
      assert.equal(persona.name, "");
      assert.equal(persona.role, "");
      assert.equal(persona.rules, "");
      assert.equal(setupState.state, "needs_persona");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  await runCase("setup state starts in needs_persona for empty persona", async () => {
    const harness = await createMemoryHarness();
    try {
      const setupStore = new SetupStateStore(harness.dataDir, harness.whitelistStore, pino({ level: "silent" }));
      const persona = await harness.personaStore.get();
      const state = await setupStore.init(persona);
      assert.equal(state.state, "needs_persona");
      assert.ok(setupStore.describeMissingFields(persona).length > 0);
    } finally {
      await harness.cleanup();
    }
  });

  await runCase("user memories support overwrite list semantics", async () => {
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
