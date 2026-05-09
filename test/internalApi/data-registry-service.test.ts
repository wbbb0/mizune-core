import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataRegistryService } from "../../src/internalApi/application/dataRegistryService.ts";
import { createEmptyGlobalProfileReadiness } from "../../src/identity/globalProfileReadinessSchema.ts";
import { persistedUserSchema, type PersistedUser } from "../../src/identity/userSchema.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createEmptyScenarioProfile } from "../../src/modes/scenarioHost/profileSchema.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { pendingRequestSchema, type PendingRequest } from "../../src/requests/requestSchema.ts";
import { scheduledJobRecordSchema, type ScheduledJobRecord } from "../../src/runtime/scheduler/jobSchema.ts";

function createRegistryService(dataDir: string, options: { schedulerEnabled?: boolean } = {}) {
  const persona = createEmptyPersona();
  const rpProfile = createEmptyRpProfile();
  const scenarioProfile = createEmptyScenarioProfile();
  const globalProfileReadiness = createEmptyGlobalProfileReadiness();
  const users: PersistedUser[] = [];
  const requests: PendingRequest[] = [];
  const scheduledJobs: ScheduledJobRecord[] = [];
  let schedulerReloadCount = 0;
  const whitelistRows: Array<{ targetType: "user" | "group"; targetId: string; createdAtMs: number }> = [];
  const service = createDataRegistryService({
    config: {
      dataDir,
      scheduler: {
        enabled: options.schedulerEnabled ?? true
      }
    },
    personaStore: {
      async get() {
        return persona;
      },
      async write(nextPersona) {
        Object.assign(persona, nextPersona);
      }
    },
    rpProfileStore: {
      async get() {
        return rpProfile;
      },
      async write(nextProfile) {
        Object.assign(rpProfile, nextProfile);
      }
    },
    scenarioProfileStore: {
      async get() {
        return scenarioProfile;
      },
      async write(nextProfile) {
        Object.assign(scenarioProfile, nextProfile);
      }
    },
    globalProfileReadinessStore: {
      async get() {
        return globalProfileReadiness;
      },
      async write(nextReadiness) {
        Object.assign(globalProfileReadiness, nextReadiness);
        return globalProfileReadiness;
      }
    },
    setupStore: {
      async get() {
        return {
          state: "ready" as const,
          ownerPromptSentAt: null,
          updatedAt: 1
        };
      }
    },
    userStore: {
      async listRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          rows: users.slice(offset, offset + limit),
          total: users.length,
          offset,
          limit
        };
      },
      async getPersistedRow(userId) {
        return users.find((user) => user.userId === userId) ?? null;
      },
      async createPersistedRow(value) {
        const raw = value as { userId: string; preferredAddress?: string; memories?: unknown[]; createdAt?: number };
        if (users.some((user) => user.userId === raw.userId)) {
          throw new Error(`User ${raw.userId} already exists`);
        }
        const row = persistedUserSchema.parse({
          userId: raw.userId,
          ...(raw.preferredAddress !== undefined ? { preferredAddress: raw.preferredAddress } : {}),
          memories: raw.memories ?? [],
          createdAt: raw.createdAt ?? Date.now()
        });
        users.push(row);
        return row;
      },
      async patchPersistedRow(userId, patch) {
        const index = users.findIndex((user) => user.userId === userId);
        if (index < 0) {
          throw new Error(`User ${userId} not found`);
        }
        users[index] = {
          ...users[index]!,
          ...patch,
          userId
        };
        return users[index]!;
      },
      async deletePersistedRow(userId) {
        const index = users.findIndex((user) => user.userId === userId);
        if (index >= 0) {
          users.splice(index, 1);
        }
      }
    },
    requestStore: {
      async listRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          rows: requests.slice(offset, offset + limit),
          total: requests.length,
          offset,
          limit
        };
      },
      async get(flag) {
        return requests.find((request) => request.flag === flag) ?? null;
      },
      async createRow(value) {
        const row = pendingRequestSchema.parse(value);
        if (requests.some((request) => request.flag === row.flag)) {
          throw new Error(`Request ${row.flag} already exists`);
        }
        requests.push(row);
        return row;
      },
      async patchRow(flag, patch) {
        const index = requests.findIndex((request) => request.flag === flag);
        if (index < 0) {
          throw new Error(`Request ${flag} not found`);
        }
        requests[index] = pendingRequestSchema.parse({
          ...requests[index]!,
          ...patch,
          flag
        });
        return requests[index]!;
      },
      async deleteRow(flag) {
        const index = requests.findIndex((request) => request.flag === flag);
        if (index >= 0) {
          requests.splice(index, 1);
        }
      }
    },
    scheduledJobStore: {
      async listRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          rows: scheduledJobs.slice(offset, offset + limit),
          total: scheduledJobs.length,
          offset,
          limit
        };
      },
      async getRow(jobId) {
        return scheduledJobs.find((job) => job.id === jobId) ?? null;
      },
      async createRow(value) {
        const row = scheduledJobRecordSchema.parse(value);
        if (scheduledJobs.some((job) => job.id === row.id)) {
          throw new Error(`Scheduled job ${row.id} already exists`);
        }
        scheduledJobs.push(row);
        return row;
      },
      async patchRow(jobId, patch) {
        const index = scheduledJobs.findIndex((job) => job.id === jobId);
        if (index < 0) {
          throw new Error(`Scheduled job ${jobId} not found`);
        }
        scheduledJobs[index] = scheduledJobRecordSchema.parse({
          ...scheduledJobs[index]!,
          ...patch,
          id: jobId
        });
        return scheduledJobs[index]!;
      },
      async deleteRow(jobId) {
        const index = scheduledJobs.findIndex((job) => job.id === jobId);
        if (index >= 0) {
          scheduledJobs.splice(index, 1);
        }
      }
    },
    scheduler: {
      async reloadFromStore() {
        schedulerReloadCount += 1;
      }
    },
    whitelistStore: {
      async listEntries() {
        return [...whitelistRows];
      },
      async upsertEntry(targetType, targetId) {
        const row = { targetType, targetId, createdAtMs: Date.now() };
        whitelistRows.push(row);
        return row;
      },
      async deleteEntry(targetType, targetId) {
        const index = whitelistRows.findIndex((row) => row.targetType === targetType && row.targetId === targetId);
        if (index >= 0) {
          whitelistRows.splice(index, 1);
        }
      }
    }
  });
  return Object.assign(service, {
    getSchedulerReloadCount: () => schedulerReloadCount
  });
}

test("DataRegistryService exposes initial file and directory resources", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    await mkdir(join(dataDir, "sessions"), { recursive: true });
    await mkdir(join(dataDir, "workspace"), { recursive: true });
    await writeFile(join(dataDir, "audio-files.json"), JSON.stringify({ files: ["a"] }), "utf8");
    await writeFile(join(dataDir, "sessions", "private%3Au1.json"), JSON.stringify({ id: "private:u1" }), "utf8");

    const service = createRegistryService(dataDir);

    const listed = await service.listResources();
    assert.deepEqual(listed.resources.map((resource) => resource.key), [
      "audio_files",
      "global_profile_readiness",
      "image_files",
      "persona",
      "requests",
      "rp_profile",
      "scenario_profile",
      "scheduled_jobs",
      "sessions",
      "setup_state",
      "users",
      "whitelist",
      "workspace_files"
    ]);
    assert.equal(listed.resources.find((resource) => resource.key === "audio_files")?.shape, "file");
    assert.equal(listed.resources.find((resource) => resource.key === "sessions")?.shape, "directory");

    assert.deepEqual(await service.getResource("audio_files"), {
      resource: {
        key: "audio_files",
        title: "Audio Files",
        shape: "file",
        editable: false,
        durability: "derived",
        storage: {
          kind: "file",
          path: join(dataDir, "audio-files.json")
        },
        value: { files: ["a"] }
      }
    });

    const sessions = await service.getResource("sessions") as {
      resource: {
        items: Array<{ key: string; title: string }>;
      };
    };
    assert.equal(sessions.resource.items.length, 1);
    assert.equal(sessions.resource.items[0]?.key, "private%3Au1.json");
    assert.equal(sessions.resource.items[0]?.title, "private:u1");

    const item = await service.getDirectoryItem("sessions", "private%3Au1.json");
    assert.deepEqual((item as { item: { value: unknown } }).item.value, { id: "private:u1" });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService rejects row and export operations for initial file resources", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    await assert.rejects(
      service.listRows("audio_files"),
      /Data resource does not contain rows: audio_files/u
    );
    await assert.rejects(
      service.exportResource("audio_files"),
      /Data resource does not support export: audio_files/u
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService exposes editable persona singleton and whitelist collection", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    const persona = await service.getResource("persona") as {
      resource: {
        shape: string;
        editable: boolean;
        value: unknown;
        uiTree?: unknown;
      };
    };
    assert.equal(persona.resource.shape, "singleton");
    assert.equal(persona.resource.editable, true);
    assert.ok(persona.resource.uiTree);

    await service.patchSingleton("persona", {
      name: "Bot",
      temperament: "calm",
      speakingStyle: "clear",
      globalTraits: "",
      generalPreferences: ""
    });
    assert.deepEqual((await service.getResource("persona") as { resource: { value: unknown } }).resource.value, {
      name: "Bot",
      temperament: "calm",
      speakingStyle: "clear",
      globalTraits: "",
      generalPreferences: ""
    });

    const created = await service.createRow("whitelist", {
      targetType: "user",
      targetId: "10001"
    }) as { row: { id: string; targetType: string; targetId: string } };
    assert.equal(created.row.targetType, "user");
    assert.equal(created.row.targetId, "10001");

    const rows = await service.listRows("whitelist", { limit: 10 });
    assert.equal(rows.total, 1);
    assert.deepEqual(rows.rows.map((row) => (row as { targetId: string }).targetId), ["10001"]);

    await service.deleteRow("whitelist", created.row.id);
    assert.equal((await service.listRows("whitelist")).total, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService exposes migrated profile and setup singleton resources", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    const rpProfile = await service.getResource("rp_profile") as {
      resource: {
        shape: string;
        editable: boolean;
        uiTree?: unknown;
      };
    };
    assert.equal(rpProfile.resource.shape, "singleton");
    assert.equal(rpProfile.resource.editable, true);
    assert.ok(rpProfile.resource.uiTree);

    await service.patchSingleton("rp_profile", {
      selfPositioning: "偏克制",
      socialRole: "搭档",
      lifeContext: "夜间工作",
      physicalPresence: "安静",
      bondToUser: "长期关系",
      closenessPattern: "慢热",
      interactionPattern: "直接",
      realityContract: "现实自处",
      continuityFacts: "",
      hardLimits: "不跳出身份"
    });
    assert.equal((
      await service.getResource("rp_profile") as { resource: { value: { hardLimits: string } } }
    ).resource.value.hardLimits, "不跳出身份");

    const scenario = await service.getResource("scenario_profile") as {
      resource: {
        editable: boolean;
        value: { theme: string };
      };
    };
    assert.equal(scenario.resource.editable, true);
    assert.equal(scenario.resource.value.theme, "");

    const readiness = await service.patchSingleton("global_profile_readiness", {
      persona: "ready",
      rp: "ready",
      scenario: "uninitialized",
      updatedAt: 2
    }) as { value: { rp: string } };
    assert.equal(readiness.value.rp, "ready");

    const setupState = await service.getResource("setup_state") as {
      resource: {
        editable: boolean;
        value: { state: string };
      };
    };
    assert.equal(setupState.resource.editable, false);
    assert.equal(setupState.resource.value.state, "ready");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService exposes editable users collection", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    const listed = await service.getResource("users") as {
      resource: {
        shape: string;
        editable: boolean;
        rowUiTree?: unknown;
      };
    };
    assert.equal(listed.resource.shape, "collection");
    assert.equal(listed.resource.editable, true);
    assert.ok(listed.resource.rowUiTree);

    const created = await service.createRow("users", {
      userId: "10001",
      preferredAddress: "小王"
    }) as { row: { id: string; userId: string; preferredAddress?: string } };
    assert.equal(created.row.id, "10001");
    assert.equal(created.row.preferredAddress, "小王");
    await assert.rejects(
      service.createRow("users", {
        userId: "10001"
      }),
      /already exists/u
    );

    const patched = await service.patchRow("users", "10001", {
      patch: {
        preferredAddress: "老王"
      }
    }) as { row: { userId: string; preferredAddress?: string } };
    assert.equal(patched.row.userId, "10001");
    assert.equal(patched.row.preferredAddress, "老王");

    const rows = await service.listRows("users", { limit: 10 });
    assert.equal(rows.total, 1);
    assert.deepEqual(rows.rows.map((row) => (row as { userId: string }).userId), ["10001"]);

    await service.deleteRow("users", "10001");
    assert.equal((await service.listRows("users")).total, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService exposes editable requests collection", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    const listed = await service.getResource("requests") as {
      resource: {
        shape: string;
        editable: boolean;
        rowUiTree?: unknown;
      };
    };
    assert.equal(listed.resource.shape, "collection");
    assert.equal(listed.resource.editable, true);
    assert.ok(listed.resource.rowUiTree);

    const created = await service.createRow("requests", {
      kind: "friend",
      flag: "flag-1",
      userId: "10001",
      comment: "hello",
      createdAt: 1
    }) as { row: { id: string; flag: string; comment: string } };
    assert.ok(created.row.id);
    assert.notEqual(created.row.id, "flag-1");
    assert.equal(created.row.comment, "hello");
    await assert.rejects(
      service.createRow("requests", {
        kind: "friend",
        flag: "flag-1",
        userId: "10001",
        createdAt: 2
      }),
      /already exists/u
    );

    const patched = await service.patchRow("requests", created.row.id, {
      patch: {
        comment: "updated"
      }
    }) as { row: { flag: string; comment: string } };
    assert.equal(patched.row.flag, "flag-1");
    assert.equal(patched.row.comment, "updated");

    const rows = await service.listRows("requests", { limit: 10 });
    assert.equal(rows.total, 1);
    assert.deepEqual(rows.rows.map((row) => (row as { flag: string }).flag), ["flag-1"]);

    await service.deleteRow("requests", created.row.id);
    assert.equal((await service.listRows("requests")).total, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService exposes editable scheduled jobs collection and reloads scheduler on writes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    const listed = await service.getResource("scheduled_jobs") as {
      resource: {
        shape: string;
        editable: boolean;
        rowUiTree?: unknown;
      };
    };
    assert.equal(listed.resource.shape, "collection");
    assert.equal(listed.resource.editable, true);
    assert.ok(listed.resource.rowUiTree);

    const job = {
      id: "job-1",
      name: "daily",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: {
        kind: "delay" as const,
        delayMs: 1000
      },
      instruction: "ping",
      targets: [{ sessionId: "qqbot:p:owner" }],
      state: {
        nextRunAtMs: null,
        lastRunAtMs: null,
        lastRunStatus: null,
        lastDurationMs: null,
        lastError: null,
        consecutiveErrors: 0
      }
    };
    const created = await service.createRow("scheduled_jobs", job) as {
      row: {
        id: string;
        name: string;
      };
    };
    assert.equal(created.row.id, "job-1");
    assert.equal(service.getSchedulerReloadCount(), 1);

    const patched = await service.patchRow("scheduled_jobs", "job-1", {
      patch: {
        name: "daily updated"
      }
    }) as { row: { id: string; name: string } };
    assert.equal(patched.row.name, "daily updated");
    assert.equal(service.getSchedulerReloadCount(), 2);

    const rows = await service.listRows("scheduled_jobs", { limit: 10 });
    assert.equal(rows.total, 1);
    assert.deepEqual(rows.rows.map((row) => (row as { id: string }).id), ["job-1"]);

    await service.deleteRow("scheduled_jobs", "job-1");
    assert.equal(service.getSchedulerReloadCount(), 3);
    assert.equal((await service.listRows("scheduled_jobs")).total, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService does not start disabled scheduler after scheduled job writes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir, { schedulerEnabled: false });
    const job = {
      id: "job-1",
      name: "daily",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: {
        kind: "delay" as const,
        delayMs: 1000
      },
      instruction: "ping",
      targets: [{ sessionId: "qqbot:p:owner" }],
      state: {
        nextRunAtMs: null,
        lastRunAtMs: null,
        lastRunStatus: null,
        lastDurationMs: null,
        lastError: null,
        consecutiveErrors: 0
      }
    };
    await service.createRow("scheduled_jobs", job);
    await service.patchRow("scheduled_jobs", "job-1", {
      patch: {
        name: "daily updated"
      }
    });
    await service.deleteRow("scheduled_jobs", "job-1");
    assert.equal(service.getSchedulerReloadCount(), 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
