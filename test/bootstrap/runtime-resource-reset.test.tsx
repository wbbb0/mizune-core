import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeBootstrapState } from "../../src/app/bootstrap/bootstrapServices.ts";
import { StateDatabase } from "../../src/data/state/stateDatabase.ts";
import { RuntimeResourceStore } from "../../src/runtime/resources/runtimeResourceStore.ts";
import { RuntimeResourceRegistry } from "../../src/runtime/resources/runtimeResourceRegistry.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";

import { createSilentLogger } from "../helpers/browser-test-support.tsx";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("initializeBootstrapState initializes state database before resetting runtime resources", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-runtime-resource-reset-"));
  const logger = createSilentLogger();
  const stateDatabase = new StateDatabase(dataDir, logger);
  const runtimeResourceStore = new RuntimeResourceStore(stateDatabase);
  const runtimeResourceRegistry = new RuntimeResourceRegistry(runtimeResourceStore);

  try {
    await runtimeResourceRegistry.createShellSession({
      title: "pwd @ /tmp",
      description: "查看当前目录",
      summary: "pwd (cwd=/tmp)",
      createdAtMs: 1,
      expiresAtMs: null,
      shellSession: {
        command: "pwd",
        cwd: "/tmp",
        shell: "/bin/sh",
        tty: true,
        login: true
      }
    });
    assert.equal((await runtimeResourceRegistry.list()).length, 1);

    await initializeBootstrapState({
      config: createTestAppConfig(),
      logger,
      dataDir,
      whitelistStore: { async init() {} } as any,
      sessionPersistence: { async init() {}, async loadAll() { return []; } } as any,
      audioStore: { async init() {} } as any,
      localFileService: { async init() {} } as any,
      chatFileStore: { async init() {} } as any,
      chatMessageFileGcService: { async sweep() { return { deletedFileIds: [] }; } } as any,
      mediaVisionService: {} as any,
      mediaCaptionService: {} as any,
      comfyTaskStore: { async init() {} } as any,
      comfyTemplateCatalog: { async init() {} } as any,
      scheduledJobStore: { async init() {} } as any,
      requestStore: { async init() {} } as any,
      groupMembershipStore: { async init() {} } as any,
      userIdentityStore: { async init() {} } as any,
      userStore: { async init() {}, async list() { return []; } } as any,
      contextStore: { async init() {}, migrateUserMemories() { return 0; } } as any,
      npcDirectory: { async refresh() {} } as any,
      personaStore: { async init() {}, async get() { return createEmptyPersona(); }, isComplete() { return false; } } as any,
      globalRuleStore: { async init() {} } as any,
      toolsetRuleStore: { async init() {} } as any,
      scenarioHostStateStore: { async init() {} } as any,
      rpProfileStore: { async init() {}, async get() { return {}; }, isComplete() { return false; } } as any,
      scenarioProfileStore: { async init() {}, async get() { return {}; }, isComplete() { return false; } } as any,
      setupStore: { async init() {} } as any,
      globalProfileReadinessStore: {
        async init() {},
        async setPersonaReadiness() {},
        async setRpReadiness() {},
        async setScenarioReadiness() {}
      } as any,
      sessionManager: { restoreSessions() {}, listSessions() { return []; } } as any,
      runtimeResourceRegistry
    });

    assert.ok(stateDatabase.getStatus());
    assert.deepEqual(await runtimeResourceRegistry.list(), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
