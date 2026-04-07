import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { GlobalMemoryStore } from "../../src/memory/memoryStore.ts";
import { PersonaStore } from "../../src/persona/personaStore.ts";
import { UserStore } from "../../src/identity/userStore.ts";
import { createTestAppConfig } from "./config-fixtures.tsx";

export function createMemoryTestConfig() {
  return createTestAppConfig({
    shell: {
      enabled: true
    }
  });
}

export function createWhitelistStore(ownerId = "owner") {
  return {
    getOwnerId() {
      return ownerId;
    }
  };
}

export async function createMemoryHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-memory-test-"));
  const config = createMemoryTestConfig();
  const logger = pino({ level: "silent" });
  const whitelistStore = createWhitelistStore();
  const personaStore = new PersonaStore(dataDir, config, logger);
  const globalMemoryStore = new GlobalMemoryStore(dataDir, config, logger);
  const userStore = new UserStore(dataDir, config, whitelistStore, logger);
  await personaStore.init();
  await globalMemoryStore.init();
  await userStore.init();
  return {
    dataDir,
    personaStore,
    globalMemoryStore,
    userStore,
    whitelistStore,
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

export async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}
