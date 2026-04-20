import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { GlobalRuleStore } from "../../src/memory/globalRuleStore.ts";
import { PersonaStore } from "../../src/persona/personaStore.ts";
import { UserStore } from "../../src/identity/userStore.ts";
import { ToolsetRuleStore } from "../../src/llm/prompt/toolsetRuleStore.ts";
import { createTestAppConfig } from "./config-fixtures.tsx";

export function createMemoryTestConfig() {
  return createTestAppConfig({
    shell: {
      enabled: true
    }
  });
}

export function createIdentityStore(hasOwnerIdentity = true) {
  return {
    async hasOwnerIdentity() {
      return hasOwnerIdentity;
    }
  };
}

export async function createMemoryHarness(options?: {
  logger?: any;
}) {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-memory-test-"));
  const config = createMemoryTestConfig();
  const logger = options?.logger ?? pino({ level: "silent" });
  const userIdentityStore = createIdentityStore();
  const personaStore = new PersonaStore(dataDir, config, logger);
  const globalRuleStore = new GlobalRuleStore(dataDir, config, logger);
  const toolsetRuleStore = new ToolsetRuleStore(dataDir, config, logger);
  const userStore = new UserStore(dataDir, config, logger);
  await personaStore.init();
  await globalRuleStore.init();
  await toolsetRuleStore.init();
  await userStore.init();
  return {
    dataDir,
    personaStore,
    globalRuleStore,
    toolsetRuleStore,
    userStore,
    userIdentityStore,
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}
