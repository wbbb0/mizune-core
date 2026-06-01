import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataRegistryService } from "../../src/internalApi/application/dataRegistryService.ts";
import { createEmptyGlobalProfileReadiness } from "../../src/identity/globalProfileReadinessSchema.ts";
import { userIdentityRecordSchema, type UserIdentityRecord } from "../../src/identity/userIdentitySchema.ts";
import { persistedUserSchema, type PersistedUser } from "../../src/identity/userSchema.ts";
import { toolsetRuleSchema, type ToolsetRuleEntry } from "../../src/llm/prompt/toolsetRuleStore.ts";
import { globalRuleEntrySchema, type GlobalRuleEntry } from "../../src/memory/globalRuleEntry.ts";
import { createEmptyRpProfile } from "../../src/modes/rpAssistant/profileSchema.ts";
import { createEmptyScenarioProfile } from "../../src/modes/scenarioHost/profileSchema.ts";
import { createEmptyPersona } from "../../src/persona/personaSchema.ts";
import { pendingRequestSchema, type PendingRequest } from "../../src/requests/requestSchema.ts";
import { scheduledJobRecordSchema, type ScheduledJobRecord } from "../../src/runtime/scheduler/jobSchema.ts";
import type { StoredAudioFile } from "../../src/audio/audioStore.ts";
import type { ChatFileRecord } from "../../src/services/workspace/types.ts";

function createRegistryService(dataDir: string, options: {
  schedulerEnabled?: boolean;
  audioRows?: StoredAudioFile[];
  workspaceRows?: ChatFileRecord[];
  recentErrorRows?: Array<{
    id: number;
    capturedAtMs: number;
    level: "error" | "fatal";
    event: string;
    message: string;
    errorName: string | null;
    stack: string | null;
    context: Record<string, unknown>;
  }>;
} = {}) {
  const persona = createEmptyPersona();
  const rpProfile = createEmptyRpProfile();
  const scenarioProfile = createEmptyScenarioProfile();
  const globalProfileReadiness = createEmptyGlobalProfileReadiness();
  const users: PersistedUser[] = [];
  const requests: PendingRequest[] = [];
  const scheduledJobs: ScheduledJobRecord[] = [];
  const globalRules: GlobalRuleEntry[] = [];
  const toolsetRules: ToolsetRuleEntry[] = [];
  const userIdentities: UserIdentityRecord[] = [];
  const audioRows = [...(options.audioRows ?? [])];
  const workspaceRows = [...(options.workspaceRows ?? [])];
  const recentErrorRows = [...(options.recentErrorRows ?? [])];
  const removedAssetRefs: Array<{ assetKind: string; assetId: string }> = [];
  const sessionRows = [{
    sessionId: "private:u1",
    type: "private" as const,
    source: "web" as const,
    modeId: "assistant",
    participantKind: "user" as const,
    participantId: "u1",
    title: "u1",
    titleSource: "manual" as const,
    replyDelivery: "web" as const,
    transcriptCount: 1,
    lastActiveAtMs: 1,
    lastMessageAtMs: 1,
    updatedAtMs: 2
  }];
  const groupMembershipRows: Array<{ groupId: string; userId: string; isMember: boolean; verifiedAt: number }> = [];
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
    globalRuleStore: {
      async getAll() {
        return [...globalRules];
      },
      async getRow(ruleId) {
        return globalRules.find((item) => item.id === ruleId) ?? null;
      },
      async createRow(value) {
        const row = globalRuleEntrySchema.parse(value);
        if (globalRules.some((item) => item.id === row.id)) throw new Error(`Global rule ${row.id} already exists`);
        globalRules.push(row);
        return row;
      },
      async patchRow(ruleId, patch) {
        const index = globalRules.findIndex((item) => item.id === ruleId);
        if (index < 0) throw new Error(`Global rule ${ruleId} not found`);
        globalRules[index] = globalRuleEntrySchema.parse({ ...globalRules[index]!, ...patch, id: ruleId });
        return globalRules[index]!;
      },
      async remove(ruleId) {
        const index = globalRules.findIndex((item) => item.id === ruleId);
        if (index >= 0) globalRules.splice(index, 1);
        return [...globalRules];
      }
    },
    toolsetRuleStore: {
      async getAll() {
        return [...toolsetRules];
      },
      async getRow(ruleId) {
        return toolsetRules.find((item) => item.id === ruleId) ?? null;
      },
      async createRow(value) {
        const row = toolsetRuleSchema.parse(value);
        if (toolsetRules.some((item) => item.id === row.id)) throw new Error(`Toolset rule ${row.id} already exists`);
        toolsetRules.push(row);
        return row;
      },
      async patchRow(ruleId, patch) {
        const index = toolsetRules.findIndex((item) => item.id === ruleId);
        if (index < 0) throw new Error(`Toolset rule ${ruleId} not found`);
        toolsetRules[index] = toolsetRuleSchema.parse({ ...toolsetRules[index]!, ...patch, id: ruleId });
        return toolsetRules[index]!;
      },
      async remove(ruleId) {
        const index = toolsetRules.findIndex((item) => item.id === ruleId);
        if (index >= 0) toolsetRules.splice(index, 1);
        return [...toolsetRules];
      },
      async listToolsetRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        const rows = toolsetRules.flatMap((rule) => rule.toolsetIds.map((toolsetId, index) => ({
          ruleId: rule.id,
          toolsetId,
          sortOrder: index + 1
        })));
        return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
      }
    },
    userIdentityStore: {
      async listRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return { rows: userIdentities.slice(offset, offset + limit), total: userIdentities.length, offset, limit };
      },
      async getRow(identity) {
        return userIdentities.find((row) => row.channelId === identity.channelId && row.scope === identity.scope && row.externalId === identity.externalId) ?? null;
      },
      async createRow(value) {
        const row = userIdentityRecordSchema.parse(value);
        userIdentities.push(row);
        return row;
      },
      async patchRow(identity, patch) {
        const index = userIdentities.findIndex((row) => row.channelId === identity.channelId && row.scope === identity.scope && row.externalId === identity.externalId);
        if (index < 0) throw new Error("User identity not found");
        userIdentities[index] = userIdentityRecordSchema.parse({ ...userIdentities[index]!, ...patch });
        return userIdentities[index]!;
      },
      async deleteRow(identity) {
        const index = userIdentities.findIndex((row) => row.channelId === identity.channelId && row.scope === identity.scope && row.externalId === identity.externalId);
        if (index >= 0) userIdentities.splice(index, 1);
      }
    },
    groupMembershipStore: {
      async listRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return { rows: groupMembershipRows.slice(offset, offset + limit), total: groupMembershipRows.length, offset, limit };
      },
      async getRow(groupId, userId) {
        return groupMembershipRows.find((item) => item.groupId === groupId && item.userId === userId) ?? null;
      },
      async createRow(row) {
        if (groupMembershipRows.some((item) => item.groupId === row.groupId && item.userId === row.userId)) {
          throw new Error(`Group membership ${row.groupId}:${row.userId} already exists`);
        }
        groupMembershipRows.push(row);
        return row;
      },
      async patchRow(groupId, userId, patch) {
        const index = groupMembershipRows.findIndex((item) => item.groupId === groupId && item.userId === userId);
        if (index < 0) throw new Error(`Group membership ${groupId}:${userId} not found`);
        groupMembershipRows[index] = { ...groupMembershipRows[index]!, ...patch };
        return groupMembershipRows[index]!;
      },
      async deleteRow(groupId, userId) {
        const index = groupMembershipRows.findIndex((item) => item.groupId === groupId && item.userId === userId);
        if (index >= 0) groupMembershipRows.splice(index, 1);
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
      async listMemoryRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        const userId = typeof input.filters?.userId === "string" ? input.filters.userId : null;
        const rows = users
          .filter((user) => !userId || user.userId === userId)
          .flatMap((user) => user.memories.map((memory) => ({
            userId: user.userId,
            ...memory,
            importance: memory.importance ?? null,
            lastUsedAt: memory.lastUsedAt ?? null
          })));
        return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
      },
      async removeMemory(userId, memoryId) {
        const user = users.find((item) => item.userId === userId);
        if (!user) return null;
        user.memories = user.memories.filter((memory) => memory.id !== memoryId);
        return null;
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
      async listTargetRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        const jobId = typeof input.filters?.jobId === "string" ? input.filters.jobId : null;
        const rows = scheduledJobs
          .filter((job) => !jobId || job.id === jobId)
          .flatMap((job) => job.targets.map((target, index) => ({
            jobId: job.id,
            sessionId: target.sessionId,
            sortOrder: index + 1
          })));
        return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
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
    comfyTaskStore: {
      async listRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          rows: [],
          total: 0,
          offset,
          limit
        };
      },
      async listResultRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          rows: [],
          total: 0,
          offset,
          limit
        };
      },
      async deleteById() {
        return false;
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
      async patchEntry(currentTargetType, currentTargetId, next) {
        const index = whitelistRows.findIndex((row) => row.targetType === currentTargetType && row.targetId === currentTargetId);
        if (index < 0) throw new Error(`Whitelist entry ${currentTargetType}:${currentTargetId} not found`);
        const normalizedNext = { ...next, targetId: next.targetId.trim() };
        const existingIndex = whitelistRows.findIndex((row, rowIndex) =>
          rowIndex !== index
          && row.targetType === normalizedNext.targetType
          && row.targetId === normalizedNext.targetId
        );
        whitelistRows[index] = normalizedNext;
        if (existingIndex >= 0) {
          whitelistRows.splice(existingIndex, 1);
        }
        return normalizedNext;
      },
      async deleteEntry(targetType, targetId) {
        const index = whitelistRows.findIndex((row) => row.targetType === targetType && row.targetId === targetId);
        if (index >= 0) {
          whitelistRows.splice(index, 1);
        }
      }
    },
    contextStore: {
      listContextItems: () => ({ items: [], total: 0 }),
      getContextItem: () => null,
      deleteContextItem: () => ({ deleted: false }),
      listRawMessages: () => ({ rows: [], total: 0, offset: 0, limit: 100 }),
      listMaintenanceJobs: () => ({ rows: [], total: 0, offset: 0, limit: 100 }),
      listContextItemSources: () => ({ rows: [], total: 0, offset: 0, limit: 100 }),
      listContextItemEmbeddings: () => ({ rows: [], total: 0, offset: 0, limit: 100 }),
      listEmbeddingProfiles: () => ({ rows: [], total: 0, offset: 0, limit: 100 }),
      listManualAuditEvents: () => ({ rows: [], total: 0, offset: 0, limit: 100 })
    },
    audioStore: {
      async listRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          rows: audioRows.slice(offset, offset + limit),
          total: audioRows.length,
          offset,
          limit
        };
      },
      async getRow(audioId) {
        return audioRows.find((row) => row.id === audioId) ?? null;
      },
      async deleteAudio(audioId) {
        const index = audioRows.findIndex((row) => row.id === audioId);
        if (index < 0) return false;
        audioRows.splice(index, 1);
        return true;
      }
    },
    chatFileStore: {
      async listRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          rows: workspaceRows.slice(offset, offset + limit),
          total: workspaceRows.length,
          offset,
          limit
        };
      },
      async getRow(fileId) {
        return workspaceRows.find((row) => row.fileId === fileId) ?? null;
      },
      async deleteFile(fileId) {
        const index = workspaceRows.findIndex((row) => row.fileId === fileId);
        if (index < 0) return false;
        workspaceRows.splice(index, 1);
        return true;
      }
    },
    assetLifecycleStore: {
      async listRows(input = {}) {
        return { rows: [], total: 0, offset: input.offset ?? 0, limit: input.limit ?? 100 };
      },
      async removeRefsForAsset(assetKind, assetId) {
        removedAssetRefs.push({ assetKind, assetId });
        return 1;
      }
    },
    sessionPersistence: {
      async listSessionRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          rows: sessionRows.slice(offset, offset + limit),
          total: sessionRows.length,
          offset,
          limit
        };
      },
      async listTranscriptRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        const sessionId = typeof input.filters?.sessionId === "string" ? input.filters.sessionId : null;
        const rows = [{
          sessionId: "private:u1",
          itemIndex: 0,
          itemId: "ti_1",
          groupId: "tg_1",
          kind: "user_message",
          role: "user",
          llmVisible: 1 as const,
          runtimeExcluded: 0 as const,
          timestampMs: 1,
          itemHash: "hash",
          item: { id: "ti_1", kind: "user_message", text: "hello" }
        }].filter((row) => !sessionId || row.sessionId === sessionId);
        return {
          rows: rows.slice(offset, offset + limit),
          total: rows.length,
          offset,
          limit
        };
      }
    },
    runtimeResourceStore: {
      async listRows() {
        return { rows: [], total: 0, offset: 0, limit: 100 };
      },
      list: async () => [],
      async listBrowserPageRows() {
        return { rows: [], total: 0, offset: 0, limit: 100 };
      },
      async listShellSessionRows() {
        return { rows: [], total: 0, offset: 0, limit: 100 };
      }
    },
    recentErrorStore: {
      async listRows(input = {}) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          rows: recentErrorRows.slice(offset, offset + limit),
          total: recentErrorRows.length,
          offset,
          limit
        };
      }
    },
    contentSafetyStore: {
      async listRows(input = {}) {
        return { rows: [], total: 0, offset: input.offset ?? 0, limit: input.limit ?? 100 };
      }
    },
    scenarioHostStateStore: {
      async listRows(input = {}) {
        return { rows: [], total: 0, offset: input.offset ?? 0, limit: input.limit ?? 100 };
      }
    }
  });
  return Object.assign(service, {
    getSchedulerReloadCount: () => schedulerReloadCount,
    getRemovedAssetRefs: () => [...removedAssetRefs]
  });
}

test("DataRegistryService exposes initial file and directory resources", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    const listed = await service.listResources();
    assert.deepEqual(listed.resources.map((resource) => resource.key), [
      "asset_session_refs",
      "audio_files",
      "comfy_task_result_files",
      "comfy_tasks",
      "content_safety_audits",
      "context_item_embeddings",
      "context_item_sources",
      "context_items",
      "context_maintenance_jobs",
      "context_manual_audit_events",
      "context_raw_messages",
      "embedding_profiles",
      "global_profile_readiness",
      "global_rules",
      "group_membership",
      "live_resources",
      "persona",
      "recent_errors",
      "requests",
      "rp_profile",
      "runtime_browser_pages",
      "runtime_shell_sessions",
      "scenario_host_session_states",
      "scenario_profile",
      "scheduled_job_targets",
      "scheduled_jobs",
      "session_transcript_items",
      "sessions",
      "setup_state",
      "toolset_rule_toolsets",
      "toolset_rules",
      "user_identities",
      "user_memories",
      "users",
      "whitelist",
      "workspace_files"
    ]);
    assert.equal(listed.resources.find((resource) => resource.key === "audio_files")?.shape, "collection");
    assert.equal(listed.resources.find((resource) => resource.key === "asset_session_refs")?.shape, "log");
    assert.equal(listed.resources.find((resource) => resource.key === "comfy_tasks")?.shape, "collection");
    assert.equal(listed.resources.find((resource) => resource.key === "comfy_task_result_files")?.shape, "log");
    assert.equal(listed.resources.find((resource) => resource.key === "workspace_files")?.shape, "collection");
    assert.equal(listed.resources.find((resource) => resource.key === "sessions")?.shape, "collection");
    assert.equal(listed.resources.find((resource) => resource.key === "session_transcript_items")?.shape, "log");
    assert.equal(listed.resources.find((resource) => resource.key === "recent_errors")?.shape, "log");
    for (const resource of listed.resources) {
      if (resource.shape !== "collection") continue;
      if (resource.accessMode === "editable") {
        assert.equal(resource.rowOperations?.create, true, `${resource.key} should expose row creation`);
        assert.equal(resource.rowOperations?.patch, true, `${resource.key} should expose row patch`);
        assert.equal(resource.rowOperations?.delete, true, `${resource.key} should expose row deletion`);
        assert.ok(resource.rowUiTree, `${resource.key} should expose row editor schema`);
      } else if (resource.accessMode === "deletable") {
        assert.equal(resource.rowOperations?.create, false, `${resource.key} should not expose row creation`);
        assert.equal(resource.rowOperations?.patch, false, `${resource.key} should not expose row patch`);
        assert.equal(resource.rowOperations?.delete, true, `${resource.key} should expose row deletion`);
      } else {
        assert.equal(resource.rowOperations?.create, false, `${resource.key} should not expose row creation`);
        assert.equal(resource.rowOperations?.patch, false, `${resource.key} should not expose row patch`);
        assert.equal(resource.rowOperations?.delete, false, `${resource.key} should not expose row deletion`);
      }
    }

    const audioFiles = await service.getResource("audio_files") as {
      resource: {
        key: string;
        title: string;
        shape: string;
        accessMode: string;
        durability: string;
        storage: { kind: string; database: string; tableGroup: string; tables: string[] };
        rowIdentity?: { fields: string[]; encode: string };
        rowSchemaMeta?: { kind: string; fields?: Record<string, unknown> };
        export?: { enabled: boolean; fileName: string; format: string };
      };
    };
    assert.equal(audioFiles.resource.key, "audio_files");
    assert.equal(audioFiles.resource.shape, "collection");
    assert.equal(audioFiles.resource.accessMode, "deletable");
    assert.equal(audioFiles.resource.durability, "source_of_truth");
    assert.deepEqual(audioFiles.resource.storage, {
      kind: "sqlite",
      database: "assets",
      tableGroup: "assets.audio_files",
      tables: ["audio_files"]
    });
    assert.deepEqual(audioFiles.resource.rowIdentity, {
      fields: ["id"],
      encode: "single"
    });
    assert.equal(audioFiles.resource.rowSchemaMeta?.kind, "object");
    assert.ok(audioFiles.resource.rowSchemaMeta?.fields?.id);
    assert.deepEqual(audioFiles.resource.export, {
      enabled: true,
      fileName: "audio_files.json",
      format: "json"
    });

    const workspaceFiles = await service.getResource("workspace_files") as {
      resource: {
        shape: string;
        storage: { kind: string; database: string; tableGroup: string; tables: string[] };
        rowIdentity?: { fields: string[]; encode: string };
        export?: { enabled: boolean; fileName: string; format: string };
      };
    };
    assert.equal(workspaceFiles.resource.shape, "collection");
    assert.deepEqual(workspaceFiles.resource.storage, {
      kind: "sqlite",
      database: "assets",
      tableGroup: "assets.chat_files",
      tables: ["chat_files"]
    });
    assert.deepEqual(workspaceFiles.resource.rowIdentity, {
      fields: ["fileId"],
      encode: "single"
    });
    assert.deepEqual(workspaceFiles.resource.export, {
      enabled: true,
      fileName: "workspace_files.json",
      format: "json"
    });

    const sessions = await service.getResource("sessions") as {
      resource: {
        shape: string;
        model?: { table: string; children?: Array<{ resourceKey: string; parentField: string; childField: string }> };
        storage: { kind: string; database: string; tableGroup: string; tables: string[] };
      };
    };
    assert.equal(sessions.resource.shape, "collection");
    assert.equal(sessions.resource.model?.table, "sessions");
    assert.deepEqual(sessions.resource.model?.children, [{
      resourceKey: "session_transcript_items",
      title: "Transcript",
      parentField: "sessionId",
      childField: "sessionId"
    }]);
    assert.deepEqual(sessions.resource.storage, {
      kind: "sqlite",
      database: "sessions",
      tableGroup: "sessions.persisted_sessions",
      tables: ["sessions"]
    });
    const sessionRows = await service.listRows("sessions");
    assert.equal(sessionRows.rows.length, 1);
    assert.equal((sessionRows.rows[0] as { sessionId: string }).sessionId, "private:u1");

    const transcriptRows = await service.listRows("session_transcript_items");
    assert.equal(transcriptRows.rows.length, 1);
    assert.equal((transcriptRows.rows[0] as { itemId: string }).itemId, "ti_1");
    const filteredTranscriptRows = await service.listRows("session_transcript_items", {
      filters: { sessionId: "missing" }
    });
    assert.equal(filteredTranscriptRows.rows.length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService exposes recent error rows", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir, {
      recentErrorRows: [{
        id: 7,
        capturedAtMs: 1234,
        level: "error",
        event: "generation_failed",
        message: "boom",
        errorName: "Error",
        stack: "Error: boom",
        context: { sessionId: "qqbot:p:10001" }
      }]
    });

    const listed = await service.getResource("recent_errors") as {
      resource: {
        key: string;
        title: string;
        shape: string;
        accessMode: string;
        storage: { kind: string; database: string; tableGroup: string; tables: string[] };
        rowIdentity?: { fields: string[]; encode: string };
        export?: { enabled: boolean; fileName: string; format: string };
      };
    };
    assert.equal(listed.resource.key, "recent_errors");
    assert.equal(listed.resource.title, "最近报错");
    assert.equal(listed.resource.shape, "log");
    assert.equal(listed.resource.accessMode, "readonly");
    assert.deepEqual(listed.resource.storage, {
      kind: "sqlite",
      database: "state",
      tableGroup: "state.recent_errors",
      tables: ["recent_errors"]
    });
    assert.deepEqual(listed.resource.rowIdentity, { fields: ["id"], encode: "single" });
    assert.deepEqual(listed.resource.export, {
      enabled: true,
      fileName: "recent_errors.json",
      format: "json"
    });

    const rows = await service.listRows("recent_errors", { limit: 10 });
    assert.equal(rows.total, 1);
    assert.deepEqual(rows.rows[0], {
      id: 7,
      capturedAtMs: 1234,
      level: "error",
      event: "generation_failed",
      message: "boom",
      errorName: "Error",
      stack: "Error: boom",
      context: { sessionId: "qqbot:p:10001" }
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService rejects row and export operations for removed or file-only resources", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    await assert.rejects(
      service.getResource("image_files"),
      /Unknown data resource: image_files/u
    );
    await assert.rejects(
      service.listRows("sessions_nope"),
      /Unknown data resource: sessions_nope/u
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService exposes and exports audio_files sqlite rows", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir, {
      audioRows: [{
        id: "aud_1",
        source: "https://example.com/audio.mp3",
        createdAt: 123,
        transcription: "hello",
        transcriptionStatus: "ready",
        transcriptionUpdatedAt: 456,
        transcriptionModelRef: "main",
        transcriptionError: null
      }]
    });

    const listed = await service.listRows("audio_files");
    assert.equal(listed.rows.length, 1);
    assert.equal((listed.rows[0] as StoredAudioFile).id, "aud_1");

    const row = await service.getRow("audio_files", "aud_1") as { row: StoredAudioFile };
    assert.equal(row.row.transcriptionStatus, "ready");

    const exported = await service.exportResource("audio_files") as { filePath: string };
    const dump = JSON.parse(await readFile(exported.filePath, "utf8")) as StoredAudioFile[];
    assert.equal(dump[0]?.id, "aud_1");
    assert.equal(dump[0]?.transcription, "hello");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService exposes delete-only persistent collections", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir, {
      audioRows: [{
        id: "audio-1",
        source: "voice.ogg",
        createdAt: 1,
        transcription: null,
        transcriptionStatus: "missing",
        transcriptionUpdatedAt: null,
        transcriptionModelRef: null,
        transcriptionError: null
      }]
    });

    const audioFiles = await service.getResource("audio_files") as {
      resource: {
        accessMode: string;
        rowOperations?: { get: boolean; create: boolean; patch: boolean; delete: boolean };
      };
    };
    assert.equal(audioFiles.resource.accessMode, "deletable");
    assert.deepEqual(audioFiles.resource.rowOperations, {
      get: true,
      create: false,
      patch: false,
      delete: true
    });
    await assert.rejects(
      service.patchRow("audio_files", "audio-1", { patch: { source: "next.ogg" } }),
      /Data resource does not allow editing: audio_files/u
    );
    await service.deleteRow("audio_files", "audio-1");
    assert.equal((await service.listRows("audio_files")).total, 0);
    assert.deepEqual(service.getRemovedAssetRefs(), [{ assetKind: "audio", assetId: "audio-1" }]);
    await assert.rejects(
      service.deleteRow("audio_files", "missing-audio"),
      /Unknown audio file: missing-audio/u
    );

    const sessions = await service.getResource("sessions") as {
      resource: {
        accessMode: string;
        rowOperations?: { get: boolean; create: boolean; patch: boolean; delete: boolean };
      };
    };
    assert.equal(sessions.resource.accessMode, "readonly");
    assert.deepEqual(sessions.resource.rowOperations, {
      get: false,
      create: false,
      patch: false,
      delete: false
    });
    await assert.rejects(
      service.deleteRow("sessions", "private:u1"),
      /Data resource does not allow deletion: sessions/u
    );

    await service.createRow("users", {
      userId: "10001",
      memories: [{
        id: "mem-1",
        title: "偏好",
        content: "喜欢简洁回答",
        kind: "preference",
        source: "user_explicit",
        createdAt: 1,
        updatedAt: 1
      }],
      createdAt: 1
    });
    const userMemories = await service.getResource("user_memories") as {
      resource: {
        accessMode: string;
        rowOperations?: { get: boolean; create: boolean; patch: boolean; delete: boolean };
      };
    };
    assert.equal(userMemories.resource.accessMode, "deletable");
    assert.deepEqual(userMemories.resource.rowOperations, {
      get: false,
      create: false,
      patch: false,
      delete: true
    });
    const userMemoryRowId = Buffer.from(JSON.stringify({ userId: "10001", id: "mem-1" }), "utf8").toString("base64url");
    await service.deleteRow("user_memories", userMemoryRowId);
    assert.equal((await service.listRows("user_memories")).total, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService exposes and exports workspace_files sqlite rows", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir, {
      workspaceRows: [{
        fileId: "file_1",
        fileRef: "upload_1.txt",
        kind: "file",
        origin: "user_upload",
        chatFilePath: "chat-files/media/upload_1.txt",
        sourceName: "upload.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        createdAtMs: 123,
        sourceContext: { source: "upload" },
        caption: null,
        captionStatus: "missing",
        captionUpdatedAtMs: undefined,
        captionModelRef: null,
        captionError: null
      }]
    });

    const listed = await service.listRows("workspace_files");
    assert.equal(listed.rows.length, 1);
    assert.equal((listed.rows[0] as ChatFileRecord).fileId, "file_1");

    const row = await service.getRow("workspace_files", "file_1") as { row: ChatFileRecord };
    assert.equal(row.row.sourceName, "upload.txt");

    const exported = await service.exportResource("workspace_files") as { filePath: string };
    const dump = JSON.parse(await readFile(exported.filePath, "utf8")) as ChatFileRecord[];
    assert.equal(dump[0]?.fileId, "file_1");

    await service.deleteRow("workspace_files", "file_1");
    assert.equal((await service.listRows("workspace_files")).total, 0);
    assert.deepEqual(service.getRemovedAssetRefs(), [{ assetKind: "chat_file", assetId: "file_1" }]);
    await assert.rejects(
      service.deleteRow("workspace_files", "missing-file"),
      /Unknown workspace file: missing-file/u
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService exports registry resources to stable dump files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    await service.patchSingleton("persona", {
      name: "Bot",
      temperament: "calm",
      voiceStyle: "clear"
    });
    const first = await service.exportResource("persona") as { filePath: string; bytes: number };
    assert.equal(first.filePath, join(dataDir, "dumps", "persona.json"));
    assert.ok(first.bytes > 0);
    assert.equal((JSON.parse(await readFile(first.filePath, "utf8")) as { name: string }).name, "Bot");

    await service.patchSingleton("persona", {
      name: "Bot 2",
      temperament: "calm",
      voiceStyle: "clear"
    });
    const second = await service.exportResource("persona") as { filePath: string };
    assert.equal(second.filePath, first.filePath);
    assert.equal((JSON.parse(await readFile(second.filePath, "utf8")) as { name: string }).name, "Bot 2");

    await service.createRow("global_rules", {
      id: "rule-1",
      title: "先给结论",
      content: "所有任务先给结论。",
      kind: "workflow",
      source: "owner_explicit",
      createdAt: 1,
      updatedAt: 1
    });
    const exportedRules = await service.exportResource("global_rules") as { filePath: string };
    assert.equal(exportedRules.filePath, join(dataDir, "dumps", "global_rules.json"));
    assert.equal((JSON.parse(await readFile(exportedRules.filePath, "utf8")) as Array<{ id: string }>)[0]?.id, "rule-1");

    await service.createRow("user_identities", {
      channelId: "qqbot",
      scope: "private_user",
      externalId: "10001",
      internalUserId: "owner",
      createdAt: 2
    });
    const exportedIdentities = await service.exportResource("user_identities") as { filePath: string };
    const identityDump = JSON.parse(await readFile(exportedIdentities.filePath, "utf8")) as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(identityDump[0]!).sort(), [
      "channelId",
      "createdAt",
      "externalId",
      "internalUserId",
      "scope"
    ]);
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
        accessMode: string;
        value: unknown;
        uiTree?: unknown;
      };
    };
    assert.equal(persona.resource.shape, "singleton");
    assert.equal(persona.resource.accessMode, "editable");
    assert.ok(persona.resource.uiTree);

    await service.patchSingleton("persona", {
      name: "Bot",
      temperament: "calm",
      voiceStyle: "clear"
    });
    assert.deepEqual((await service.getResource("persona") as { resource: { value: unknown } }).resource.value, {
      name: "Bot",
      temperament: "calm",
      voiceStyle: "clear"
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

    const patched = await service.patchRow("whitelist", created.row.id, {
      patch: { targetId: "10002" }
    }) as { row: { id: string; targetType: string; targetId: string } };
    assert.equal(patched.row.targetType, "user");
    assert.equal(patched.row.targetId, "10002");
    assert.notEqual(patched.row.id, created.row.id);

    await service.deleteRow("whitelist", patched.row.id);
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
        accessMode: string;
        uiTree?: unknown;
      };
    };
    assert.equal(rpProfile.resource.shape, "singleton");
    assert.equal(rpProfile.resource.accessMode, "editable");
    assert.ok(rpProfile.resource.uiTree);

    await service.patchSingleton("rp_profile", {
      identity: "搭档",
      background: "夜间工作",
      continuityFacts: "",
      boundaries: "不跳出身份"
    });
    assert.equal((
      await service.getResource("rp_profile") as { resource: { value: { boundaries: string } } }
    ).resource.value.boundaries, "不跳出身份");

    const scenario = await service.getResource("scenario_profile") as {
      resource: {
        accessMode: string;
        value: { theme: string };
      };
    };
    assert.equal(scenario.resource.accessMode, "editable");
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
        accessMode: string;
        value: { state: string };
      };
    };
    assert.equal(setupState.resource.accessMode, "readonly");
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
        accessMode: string;
        rowUiTree?: unknown;
      };
    };
    assert.equal(listed.resource.shape, "collection");
    assert.equal(listed.resource.accessMode, "editable");
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

test("DataRegistryService exposes editable rule collections", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    const globalRules = await service.getResource("global_rules") as {
      resource: {
        shape: string;
        accessMode: string;
        rowUiTree?: unknown;
        storage: { kind: string; tableGroup?: string; tables?: string[] };
      };
    };
    assert.equal(globalRules.resource.shape, "collection");
    assert.equal(globalRules.resource.accessMode, "editable");
    assert.equal(globalRules.resource.storage.kind, "sqlite");
    assert.equal(globalRules.resource.storage.tableGroup, "state.rules");
    assert.deepEqual(globalRules.resource.storage.tables, ["global_rules"]);
    assert.ok(globalRules.resource.rowUiTree);

    const createdGlobal = await service.createRow("global_rules", {
      id: "rule-1",
      title: "总是简洁",
      content: "回答需要先给结论。",
      kind: "workflow",
      source: "owner_explicit",
      createdAt: 1,
      updatedAt: 1
    }) as { row: { id: string; title: string } };
    assert.equal(createdGlobal.row.id, "rule-1");
    await assert.rejects(
      service.createRow("global_rules", {
        id: "rule-1",
        title: "重复",
        content: "重复内容",
        kind: "workflow",
        source: "owner_explicit",
        createdAt: 1,
        updatedAt: 1
      }),
      /already exists/u
    );

    const patchedGlobal = await service.patchRow("global_rules", "rule-1", {
      patch: { title: "总是先给结论" }
    }) as { row: { id: string; title: string } };
    assert.equal(patchedGlobal.row.id, "rule-1");
    assert.equal(patchedGlobal.row.title, "总是先给结论");

    const toolsetRules = await service.getResource("toolset_rules") as {
      resource: {
        rowUiTree?: unknown;
        storage: { tables?: string[] };
      };
    };
    assert.deepEqual(toolsetRules.resource.storage.tables, ["toolset_rules", "toolset_rule_toolsets"]);
    assert.ok(toolsetRules.resource.rowUiTree);

    const createdToolset = await service.createRow("toolset_rules", {
      id: "toolset-rule-1",
      title: "Shell 写入限制",
      content: "写文件前先说明。",
      toolsetIds: ["shell"],
      source: "owner_explicit",
      createdAt: 1,
      updatedAt: 1
    }) as { row: { id: string; toolsetIds: string[] } };
    assert.equal(createdToolset.row.id, "toolset-rule-1");
    assert.deepEqual(createdToolset.row.toolsetIds, ["shell"]);

    await service.deleteRow("global_rules", "rule-1");
    await service.deleteRow("toolset_rules", "toolset-rule-1");
    assert.equal((await service.listRows("global_rules")).total, 0);
    assert.equal((await service.listRows("toolset_rules")).total, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DataRegistryService exposes editable identity and membership collections", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "llm-bot-data-registry-test-"));
  try {
    const service = createRegistryService(dataDir);

    const identity = await service.createRow("user_identities", {
      channelId: "qqbot",
      scope: "private_user",
      externalId: "10001",
      internalUserId: "owner",
      createdAt: 123
    }) as { row: { id: string; internalUserId: string; createdAt: number } };
    assert.ok(identity.row.id);
    assert.equal(identity.row.internalUserId, "owner");
    assert.equal(identity.row.createdAt, 123);

    const fetchedIdentity = await service.getRow("user_identities", identity.row.id) as {
      row: { externalId: string };
    };
    assert.equal(fetchedIdentity.row.externalId, "10001");

    const patchedIdentity = await service.patchRow("user_identities", identity.row.id, {
      patch: { internalUserId: "u_10001" }
    }) as { row: { internalUserId: string } };
    assert.equal(patchedIdentity.row.internalUserId, "u_10001");

    const membership = await service.createRow("group_membership", {
      groupId: "20001",
      userId: "10001",
      isMember: true,
      verifiedAt: 456
    }) as { row: { id: string; isMember: boolean; verifiedAt: number } };
    assert.equal(membership.row.isMember, true);
    assert.equal(membership.row.verifiedAt, 456);
    await assert.rejects(
      service.createRow("group_membership", {
        groupId: "20001",
        userId: "10001",
        isMember: false,
        verifiedAt: 457
      }),
      /already exists/u
    );

    const fetchedMembership = await service.getRow("group_membership", membership.row.id) as {
      row: { groupId: string; userId: string };
    };
    assert.equal(fetchedMembership.row.groupId, "20001");
    assert.equal(fetchedMembership.row.userId, "10001");

    const patchedMembership = await service.patchRow("group_membership", membership.row.id, {
      patch: { isMember: false }
    }) as { row: { isMember: boolean; verifiedAt: number } };
    assert.equal(patchedMembership.row.isMember, false);
    assert.equal(patchedMembership.row.verifiedAt, 456);
    const patchedMembershipTime = await service.patchRow("group_membership", membership.row.id, {
      patch: { verifiedAt: 789 }
    }) as { row: { isMember: boolean; verifiedAt: number } };
    assert.equal(patchedMembershipTime.row.isMember, false);
    assert.equal(patchedMembershipTime.row.verifiedAt, 789);

    for (let index = 0; index < 101; index += 1) {
      await service.createRow("group_membership", {
        groupId: "20001",
        userId: `bulk-${index.toString().padStart(3, "0")}`,
        isMember: true,
        verifiedAt: index
      });
    }
    const late = await service.createRow("group_membership", {
      groupId: "20001",
      userId: "zzzz",
      isMember: true,
      verifiedAt: 999
    }) as { row: { id: string } };
    const fetchedLate = await service.getRow("group_membership", late.row.id) as {
      row: { userId: string; verifiedAt: number };
    };
    assert.equal(fetchedLate.row.userId, "zzzz");
    assert.equal(fetchedLate.row.verifiedAt, 999);

    await service.deleteRow("user_identities", identity.row.id);
    await service.deleteRow("group_membership", membership.row.id);
    assert.equal((await service.listRows("user_identities")).total, 0);
    assert.equal((await service.listRows("group_membership")).total, 102);
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
        accessMode: string;
        rowUiTree?: unknown;
      };
    };
    assert.equal(listed.resource.shape, "collection");
    assert.equal(listed.resource.accessMode, "editable");
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
        accessMode: string;
        rowUiTree?: unknown;
      };
    };
    assert.equal(listed.resource.shape, "collection");
    assert.equal(listed.resource.accessMode, "editable");
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
