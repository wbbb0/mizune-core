import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeBootstrapState } from "../../src/app/bootstrap/bootstrapServices.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";

import { createSilentLogger } from "../helpers/browser-test-support.tsx";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

  test("initializeBootstrapState clears persisted runtime resources on startup", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-runtime-resource-reset-"));

    try {
      await writeFile(join(dataDir, "live-resources.json"), JSON.stringify({
        resources: [{
          resourceId: "res_shell_1",
          kind: "shell_session",
          status: "active",
          ownerSessionId: null,
          title: "pwd @ /tmp",
          description: "查看当前目录",
          summary: "pwd (cwd=/tmp)",
          createdAtMs: 1,
          lastAccessedAtMs: 2,
          expiresAtMs: null,
          shellSession: {
            command: "pwd",
            cwd: "/tmp",
            shell: "/bin/sh",
            tty: true,
            login: true
          }
        }]
      }, null, 2), "utf8");

      await initializeBootstrapState({
        config: createTestAppConfig(),
        logger: createSilentLogger(),
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
        sessionManager: { restoreSessions() {}, listSessions() { return []; } } as any
      });

      const persisted = JSON.parse(await readFile(join(dataDir, "live-resources.json"), "utf8"));
      assert.deepEqual(persisted, { resources: [] });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
