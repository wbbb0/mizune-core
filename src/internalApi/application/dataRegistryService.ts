import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "#config/config.ts";
import type { ContextStore } from "#context/contextStore.ts";
import { DataRegistry, type DataResourceDefinition } from "#data/registry/index.ts";
import { s, type BaseSchema } from "#data/schema/index.ts";
import { exportSchemaMeta } from "#data/schema/composites.ts";
import { readStructuredFileRaw } from "#data/schema/file.ts";
import { buildUiTreeFromMeta } from "#data/schema/ui.ts";
import { globalProfileReadinessSchema } from "#identity/globalProfileReadinessSchema.ts";
import type { GlobalProfileReadinessStore } from "#identity/globalProfileReadinessStore.ts";
import { setupStateSchema } from "#identity/setupStateSchema.ts";
import type { SetupStateStore } from "#identity/setupStateStore.ts";
import { storedAudioFileRegistrySchema, type AudioStore } from "#audio/audioStore.ts";
import { userIdentityRecordSchema, type UserIdentityRecord } from "#identity/userIdentitySchema.ts";
import type { UserIdentityStore } from "#identity/userIdentityStore.ts";
import { persistedUserSchema } from "#identity/userSchema.ts";
import type { UserStore } from "#identity/userStore.ts";
import type { GroupMembershipRow, GroupMembershipStore } from "#identity/groupMembershipStore.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";
import { toolsetRuleSchema, type ToolsetRuleStore } from "#llm/prompt/toolsetRuleStore.ts";
import { globalRuleEntrySchema, type GlobalRuleEntry } from "#memory/globalRuleEntry.ts";
import type { GlobalRuleStore } from "#memory/globalRuleStore.ts";
import { rpProfileSchema } from "#modes/rpAssistant/profileSchema.ts";
import type { RpProfileStore } from "#modes/rpAssistant/profileStore.ts";
import { scenarioProfileSchema } from "#modes/scenarioHost/profileSchema.ts";
import type { ScenarioProfileStore } from "#modes/scenarioHost/profileStore.ts";
import { personaSchema } from "#persona/personaSchema.ts";
import type { PersonaStore } from "#persona/personaStore.ts";
import { pendingRequestSchema } from "#requests/requestSchema.ts";
import type { RequestStore } from "#requests/requestStore.ts";
import { scheduledJobRecordSchema } from "#runtime/scheduler/jobSchema.ts";
import type { ScheduledJobStore } from "#runtime/scheduler/jobStore.ts";
import type { Scheduler } from "#runtime/scheduler/scheduler.ts";
import type { RuntimeResourceStore } from "#runtime/resources/runtimeResourceStore.ts";
import { chatFileRecordRegistrySchema, type ChatFileStore } from "#services/workspace/chatFileStore.ts";

export interface DataRegistryService {
  listResources: DataRegistry["listResources"];
  getResource: DataRegistry["getResource"];
  patchSingleton: DataRegistry["patchSingleton"];
  listRows: DataRegistry["listRows"];
  getRow: DataRegistry["getRow"];
  createRow: DataRegistry["createRow"];
  patchRow: DataRegistry["patchRow"];
  deleteRow: DataRegistry["deleteRow"];
  exportResource: DataRegistry["exportResource"];
  getDirectoryItem: DataRegistry["getDirectoryItem"];
}

export function createDataRegistryService(input: {
  config: Pick<AppConfig, "dataDir"> & { scheduler: Pick<AppConfig["scheduler"], "enabled"> };
  personaStore: Pick<PersonaStore, "get" | "write">;
  rpProfileStore: Pick<RpProfileStore, "get" | "write">;
  scenarioProfileStore: Pick<ScenarioProfileStore, "get" | "write">;
  globalProfileReadinessStore: Pick<GlobalProfileReadinessStore, "get" | "write">;
  setupStore: Pick<SetupStateStore, "get">;
  globalRuleStore: Pick<GlobalRuleStore, "getAll" | "getRow" | "createRow" | "patchRow" | "remove">;
  toolsetRuleStore: Pick<ToolsetRuleStore, "getAll" | "getRow" | "createRow" | "patchRow" | "remove">;
  userIdentityStore: Pick<UserIdentityStore, "listRows" | "getRow" | "createRow" | "patchRow" | "deleteRow">;
  groupMembershipStore: Pick<GroupMembershipStore, "listRows" | "getRow" | "createRow" | "patchRow" | "deleteRow">;
  userStore: Pick<UserStore, "listRows" | "getPersistedRow" | "createPersistedRow" | "patchPersistedRow" | "deletePersistedRow">;
  requestStore: Pick<RequestStore, "listRows" | "get" | "createRow" | "patchRow" | "deleteRow">;
  scheduledJobStore: Pick<ScheduledJobStore, "listRows" | "getRow" | "createRow" | "patchRow" | "deleteRow">;
  scheduler: Pick<Scheduler, "reloadFromStore">;
  whitelistStore: Pick<WhitelistStore, "listEntries" | "upsertEntry" | "deleteEntry">;
  contextStore: Pick<ContextStore, "listContextItems" | "getContextItem" | "listRawMessages" | "listMaintenanceJobs">;
  audioStore: Pick<AudioStore, "listRows" | "getRow">;
  chatFileStore: Pick<ChatFileStore, "listRows" | "getRow">;
  runtimeResourceStore: Pick<RuntimeResourceStore, "listRows" | "list">;
}): DataRegistryService {
  const registry = new DataRegistry({
    dumpDir: join(input.config.dataDir, "dumps")
  });
  for (const definition of createInitialDataResourceDefinitions(input)) {
    registry.register(definition);
  }
  return registry;
}

function createInitialDataResourceDefinitions(input: {
  config: Pick<AppConfig, "dataDir"> & { scheduler: Pick<AppConfig["scheduler"], "enabled"> };
  personaStore: Pick<PersonaStore, "get" | "write">;
  rpProfileStore: Pick<RpProfileStore, "get" | "write">;
  scenarioProfileStore: Pick<ScenarioProfileStore, "get" | "write">;
  globalProfileReadinessStore: Pick<GlobalProfileReadinessStore, "get" | "write">;
  setupStore: Pick<SetupStateStore, "get">;
  globalRuleStore: Pick<GlobalRuleStore, "getAll" | "getRow" | "createRow" | "patchRow" | "remove">;
  toolsetRuleStore: Pick<ToolsetRuleStore, "getAll" | "getRow" | "createRow" | "patchRow" | "remove">;
  userIdentityStore: Pick<UserIdentityStore, "listRows" | "getRow" | "createRow" | "patchRow" | "deleteRow">;
  groupMembershipStore: Pick<GroupMembershipStore, "listRows" | "getRow" | "createRow" | "patchRow" | "deleteRow">;
  userStore: Pick<UserStore, "listRows" | "getPersistedRow" | "createPersistedRow" | "patchPersistedRow" | "deletePersistedRow">;
  requestStore: Pick<RequestStore, "listRows" | "get" | "createRow" | "patchRow" | "deleteRow">;
  scheduledJobStore: Pick<ScheduledJobStore, "listRows" | "getRow" | "createRow" | "patchRow" | "deleteRow">;
  scheduler: Pick<Scheduler, "reloadFromStore">;
  whitelistStore: Pick<WhitelistStore, "listEntries" | "upsertEntry" | "deleteEntry">;
  contextStore: Pick<ContextStore, "listContextItems" | "getContextItem" | "listRawMessages" | "listMaintenanceJobs">;
  audioStore: Pick<AudioStore, "listRows" | "getRow">;
  chatFileStore: Pick<ChatFileStore, "listRows" | "getRow">;
  runtimeResourceStore: Pick<RuntimeResourceStore, "listRows" | "list">;
}): DataResourceDefinition[] {
  const dataDir = input.config.dataDir;
  return [
    singletonSqliteResource({
      key: "global_profile_readiness",
      title: "全局资料就绪状态",
      tableGroup: "state.global_profile_readiness",
      tables: ["global_profile_readiness"],
      schema: globalProfileReadinessSchema,
      editable: true,
      get: () => input.globalProfileReadinessStore.get(),
      write: (value) => input.globalProfileReadinessStore.write(value)
    }),
    createPersonaResource(input.personaStore),
    singletonSqliteResource({
      key: "rp_profile",
      title: "RP 全局资料",
      tableGroup: "state.rp_profile",
      tables: ["rp_profile"],
      schema: rpProfileSchema,
      editable: true,
      get: () => input.rpProfileStore.get(),
      write: async (value) => {
        await input.rpProfileStore.write(value);
        return input.rpProfileStore.get();
      }
    }),
    singletonSqliteResource({
      key: "scenario_profile",
      title: "Scenario 全局资料",
      tableGroup: "state.scenario_profile",
      tables: ["scenario_profile"],
      schema: scenarioProfileSchema,
      editable: true,
      get: () => input.scenarioProfileStore.get(),
      write: async (value) => {
        await input.scenarioProfileStore.write(value);
        return input.scenarioProfileStore.get();
      }
    }),
    singletonSqliteResource({
      key: "setup_state",
      title: "Owner 初始化状态",
      tableGroup: "state.setup_state",
      tables: ["setup_state"],
      schema: setupStateSchema,
      editable: false,
      get: () => input.setupStore.get()
    }),
    createRequestsResource(input.requestStore),
    createScheduledJobsResource(input.scheduledJobStore, input.scheduler, () => input.config.scheduler.enabled),
    createGlobalRulesResource(input.globalRuleStore),
    createToolsetRulesResource(input.toolsetRuleStore),
    createUserIdentitiesResource(input.userIdentityStore),
    createGroupMembershipResource(input.groupMembershipStore),
    createUsersResource(input.userStore),
    createWhitelistResource(input.whitelistStore),
    createContextItemsResource(input.contextStore),
    createContextRawMessagesResource(input.contextStore),
    createContextMaintenanceJobsResource(input.contextStore),
    createLiveResourcesResource(input.runtimeResourceStore),
    createAudioFilesResource(input.audioStore),
    directoryResource({
      key: "sessions",
      title: "Sessions",
      path: join(dataDir, "sessions"),
      durability: "source_of_truth"
    }),
    createWorkspaceFilesResource(input.chatFileStore)
  ];
}

function createAudioFilesResource(
  audioStore: Pick<AudioStore, "listRows" | "getRow">
): DataResourceDefinition {
  const rowSchemaMeta = exportSchemaMeta(storedAudioFileRegistrySchema);
  return {
    key: "audio_files",
    title: "Audio Files",
    shape: "collection",
    editable: false,
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "assets",
      tableGroup: "assets.audio_files",
      tables: ["audio_files"]
    },
    rowSchemaMeta,
    rowUiTree: buildUiTreeFromMeta(rowSchemaMeta),
    export: {
      enabled: true,
      fileName: "audio_files.json",
      format: "json"
    },
    rowIdentity: {
      fields: ["id"],
      encode: "single"
    },
    adapter: {
      listRows: async (query) => audioStore.listRows({
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {})
      }),
      exportRows: async (query) => audioStore.listRows({
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {})
      }),
      getRow: async (rowId) => audioStore.getRow(rowId)
    }
  };
}

function createWorkspaceFilesResource(
  chatFileStore: Pick<ChatFileStore, "listRows" | "getRow">
): DataResourceDefinition {
  const rowSchemaMeta = exportSchemaMeta(chatFileRecordRegistrySchema);
  return {
    key: "workspace_files",
    title: "Workspace Files",
    shape: "collection",
    editable: false,
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "assets",
      tableGroup: "assets.chat_files",
      tables: ["chat_files"]
    },
    rowSchemaMeta,
    rowUiTree: buildUiTreeFromMeta(rowSchemaMeta),
    export: {
      enabled: true,
      fileName: "workspace_files.json",
      format: "json"
    },
    rowIdentity: {
      fields: ["fileId"],
      encode: "single"
    },
    adapter: {
      listRows: async (query) => chatFileStore.listRows({
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {})
      }),
      exportRows: async (query) => chatFileStore.listRows({
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {})
      }),
      getRow: async (rowId) => chatFileStore.getRow(rowId)
    }
  };
}

function singletonSqliteResource<TValue>(input: {
  key: string;
  title: string;
  tableGroup: string;
  tables: string[];
  schema: BaseSchema<TValue>;
  editable: boolean;
  get: () => Promise<TValue>;
  write?: (value: TValue) => Promise<unknown>;
}): DataResourceDefinition {
  const schemaMeta = exportSchemaMeta(input.schema);
  return {
    key: input.key,
    title: input.title,
    shape: "singleton",
    editable: input.editable,
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: input.tableGroup,
      tables: input.tables
    },
    schemaMeta,
    uiTree: buildUiTreeFromMeta(schemaMeta),
    export: {
      enabled: true,
      fileName: `${input.key}.json`,
      format: "json"
    },
    adapter: {
      get: async () => input.get(),
      ...(input.editable && input.write ? {
        patch: async (value: unknown) => {
          const parsed = input.schema.parse(value);
          await input.write!(parsed);
          return input.get();
        }
      } : {})
    }
  };
}

function createRequestsResource(
  requestStore: Pick<RequestStore, "listRows" | "get" | "createRow" | "patchRow" | "deleteRow">
): DataResourceDefinition {
  const rowSchemaMeta = exportSchemaMeta(pendingRequestSchema);
  return {
    key: "requests",
    title: "待处理请求",
    shape: "collection",
    editable: true,
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "state.requests",
      tables: ["pending_requests"]
    },
    rowSchemaMeta,
    rowUiTree: buildUiTreeFromMeta(rowSchemaMeta),
    export: { enabled: true, fileName: "requests.json", format: "json" },
    rowIdentity: {
      fields: ["flag"],
      encode: "json_base64url"
    },
    adapter: {
      listRows: async (query) => {
        const result = await requestStore.listRows({
          ...(query.offset !== undefined ? { offset: query.offset } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {})
        });
        return {
          ...result,
          rows: result.rows.map((row) => ({
            id: encodeRequestRowId(row.flag),
            ...row
          }))
        };
      },
      exportRows: async (query) => requestStore.listRows({
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {})
      }),
      getRow: async (rowId) => {
        const flag = decodeRequestRowId(rowId);
        const row = await requestStore.get(flag);
        return row ? { id: encodeRequestRowId(row.flag), ...row } : null;
      },
      createRow: async (value) => {
        const row = await requestStore.createRow(value);
        return { id: encodeRequestRowId(row.flag), ...row };
      },
      patchRow: async (rowId, input) => {
        const row = await requestStore.patchRow(decodeRequestRowId(rowId), input.patch);
        return { id: encodeRequestRowId(row.flag), ...row };
      },
      deleteRow: async (rowId) => {
        await requestStore.deleteRow(decodeRequestRowId(rowId));
      }
    }
  };
}

function encodeRequestRowId(flag: string): string {
  return Buffer.from(JSON.stringify({ flag }), "utf8").toString("base64url");
}

function decodeRequestRowId(rowId: string): string {
  const parsed = JSON.parse(Buffer.from(rowId, "base64url").toString("utf8")) as unknown;
  const flag = (parsed && typeof parsed === "object" ? (parsed as { flag?: unknown }).flag : null);
  if (typeof flag !== "string" || !flag.trim()) {
    throw new Error("Invalid request row id");
  }
  return flag;
}

function createScheduledJobsResource(
  scheduledJobStore: Pick<ScheduledJobStore, "listRows" | "getRow" | "createRow" | "patchRow" | "deleteRow">,
  scheduler: Pick<Scheduler, "reloadFromStore">,
  isSchedulerEnabled: () => boolean
): DataResourceDefinition {
  const rowSchemaMeta = exportSchemaMeta(scheduledJobRecordSchema);
  return {
    key: "scheduled_jobs",
    title: "定时任务",
    shape: "collection",
    editable: true,
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "state.scheduled_jobs",
      tables: ["scheduled_jobs"]
    },
    rowSchemaMeta,
    rowUiTree: buildUiTreeFromMeta(rowSchemaMeta),
    export: { enabled: true, fileName: "scheduled_jobs.json", format: "json" },
    rowIdentity: {
      fields: ["id"],
      encode: "single"
    },
    adapter: {
      listRows: async (query) => {
        const result = await scheduledJobStore.listRows({
          ...(query.offset !== undefined ? { offset: query.offset } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {})
        });
        return {
          ...result,
          rows: result.rows
        };
      },
      exportRows: async (query) => scheduledJobStore.listRows({
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {})
      }),
      getRow: async (rowId) => {
        const row = await scheduledJobStore.getRow(rowId);
        return row;
      },
      createRow: async (value) => {
        const row = await scheduledJobStore.createRow(value);
        await reloadSchedulerIfEnabled(scheduler, isSchedulerEnabled);
        return row;
      },
      patchRow: async (rowId, input) => {
        const row = await scheduledJobStore.patchRow(rowId, input.patch);
        await reloadSchedulerIfEnabled(scheduler, isSchedulerEnabled);
        return row;
      },
      deleteRow: async (rowId) => {
        await scheduledJobStore.deleteRow(rowId);
        await reloadSchedulerIfEnabled(scheduler, isSchedulerEnabled);
      }
    }
  };
}

async function reloadSchedulerIfEnabled(
  scheduler: Pick<Scheduler, "reloadFromStore">,
  isSchedulerEnabled: () => boolean
): Promise<void> {
  if (!isSchedulerEnabled()) {
    return;
  }
  await scheduler.reloadFromStore();
}

function createGlobalRulesResource(
  globalRuleStore: Pick<GlobalRuleStore, "getAll" | "getRow" | "createRow" | "patchRow" | "remove">
): DataResourceDefinition {
  const rowSchemaMeta = exportSchemaMeta(globalRuleEntrySchema);
  return {
    key: "global_rules",
    title: "全局规则列表",
    shape: "collection",
    editable: true,
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "state.rules",
      tables: ["global_rules"]
    },
    rowSchemaMeta,
    rowUiTree: buildUiTreeFromMeta(rowSchemaMeta),
    export: { enabled: true, fileName: "global_rules.json", format: "json" },
    rowIdentity: { fields: ["id"], encode: "single" },
    adapter: {
      listRows: async (query) => {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        const rows = await globalRuleStore.getAll();
        return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
      },
      exportRows: async (query) => {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        const rows = await globalRuleStore.getAll();
        return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
      },
      getRow: async (rowId) => globalRuleStore.getRow(rowId),
      createRow: async (value) => {
        const parsed = globalRuleEntrySchema.parse(value) as GlobalRuleEntry;
        return globalRuleStore.createRow(parsed);
      },
      patchRow: async (rowId, input) => {
        return globalRuleStore.patchRow(rowId, input.patch);
      },
      deleteRow: async (rowId) => {
        await globalRuleStore.remove(rowId);
      }
    }
  };
}

function createToolsetRulesResource(
  toolsetRuleStore: Pick<ToolsetRuleStore, "getAll" | "getRow" | "createRow" | "patchRow" | "remove">
): DataResourceDefinition {
  const rowSchemaMeta = exportSchemaMeta(toolsetRuleSchema);
  return {
    key: "toolset_rules",
    title: "工具集规则列表",
    shape: "collection",
    editable: true,
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "state.rules",
      tables: ["toolset_rules", "toolset_rule_toolsets"]
    },
    rowSchemaMeta,
    rowUiTree: buildUiTreeFromMeta(rowSchemaMeta),
    export: { enabled: true, fileName: "toolset_rules.json", format: "json" },
    rowIdentity: { fields: ["id"], encode: "single" },
    adapter: {
      listRows: async (query) => {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        const rows = await toolsetRuleStore.getAll();
        return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
      },
      exportRows: async (query) => {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        const rows = await toolsetRuleStore.getAll();
        return { rows: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
      },
      getRow: async (rowId) => toolsetRuleStore.getRow(rowId),
      createRow: async (value) => {
        const parsed = toolsetRuleSchema.parse(value);
        return toolsetRuleStore.createRow(parsed);
      },
      patchRow: async (rowId, input) => {
        return toolsetRuleStore.patchRow(rowId, input.patch);
      },
      deleteRow: async (rowId) => {
        await toolsetRuleStore.remove(rowId);
      }
    }
  };
}

function createUserIdentitiesResource(
  userIdentityStore: Pick<UserIdentityStore, "listRows" | "getRow" | "createRow" | "patchRow" | "deleteRow">
): DataResourceDefinition {
  const rowSchemaMeta = exportSchemaMeta(userIdentityRecordSchema);
  return {
    key: "user_identities",
    title: "用户身份映射",
    shape: "collection",
    editable: true,
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "state.user_identities",
      tables: ["user_identities"]
    },
    rowSchemaMeta,
    rowUiTree: buildUiTreeFromMeta(rowSchemaMeta),
    export: { enabled: true, fileName: "user_identities.json", format: "json" },
    rowIdentity: { fields: ["channelId", "scope", "externalId"], encode: "json_base64url" },
    adapter: {
      listRows: async (query) => {
        const result = await userIdentityStore.listRows({
          ...(query.offset !== undefined ? { offset: query.offset } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {})
        });
        return { ...result, rows: result.rows.map((row) => ({ id: encodeUserIdentityRowId(row), ...row })) };
      },
      exportRows: async (query) => userIdentityStore.listRows({
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {})
      }),
      getRow: async (rowId) => {
        const identity = decodeUserIdentityRowId(rowId);
        const row = await userIdentityStore.getRow(identity);
        return row ? { id: encodeUserIdentityRowId(row), ...row } : null;
      },
      createRow: async (value) => {
        const row = await userIdentityStore.createRow(value);
        return { id: encodeUserIdentityRowId(row), ...row };
      },
      patchRow: async (rowId, input) => {
        const row = await userIdentityStore.patchRow(decodeUserIdentityRowId(rowId), input.patch);
        return { id: encodeUserIdentityRowId(row), ...row };
      },
      deleteRow: async (rowId) => {
        await userIdentityStore.deleteRow(decodeUserIdentityRowId(rowId));
      }
    }
  };
}

function encodeUserIdentityRowId(row: Pick<UserIdentityRecord, "channelId" | "scope" | "externalId">): string {
  return Buffer.from(JSON.stringify({
    channelId: row.channelId,
    scope: row.scope,
    externalId: row.externalId
  }), "utf8").toString("base64url");
}

function decodeUserIdentityRowId(rowId: string): Pick<UserIdentityRecord, "channelId" | "scope" | "externalId"> {
  const parsed = JSON.parse(Buffer.from(rowId, "base64url").toString("utf8")) as unknown;
  const row = userIdentityRecordSchema.parse({
    ...(parsed && typeof parsed === "object" ? parsed : {}),
    internalUserId: "placeholder",
    createdAt: 0
  });
  return {
    channelId: row.channelId,
    scope: row.scope,
    externalId: row.externalId
  };
}

const groupMembershipRowSchema = s.object({
  groupId: s.string().trim().nonempty().title("群 ID"),
  userId: s.string().trim().nonempty().title("用户 ID"),
  isMember: s.boolean().title("是否在群内"),
  verifiedAt: s.number().int().min(0).title("验证时间").default(() => Date.now())
}).title("群成员缓存条目")
  .strict();

function createGroupMembershipResource(
  groupMembershipStore: Pick<GroupMembershipStore, "listRows" | "getRow" | "createRow" | "patchRow" | "deleteRow">
): DataResourceDefinition {
  const rowSchemaMeta = exportSchemaMeta(groupMembershipRowSchema);
  return {
    key: "group_membership",
    title: "群成员缓存",
    shape: "collection",
    editable: true,
    durability: "cache",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "state.group_membership",
      tables: ["group_membership_entries"]
    },
    rowSchemaMeta,
    rowUiTree: buildUiTreeFromMeta(rowSchemaMeta),
    export: { enabled: true, fileName: "group_membership.json", format: "json" },
    rowIdentity: { fields: ["groupId", "userId"], encode: "json_base64url" },
    adapter: {
      listRows: async (query) => {
        const result = await groupMembershipStore.listRows({
          ...(query.offset !== undefined ? { offset: query.offset } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {})
        });
        return { ...result, rows: result.rows.map((row) => ({ id: encodeGroupMembershipRowId(row), ...row })) };
      },
      exportRows: async (query) => groupMembershipStore.listRows({
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {})
      }),
      getRow: async (rowId) => {
        const identity = decodeGroupMembershipRowId(rowId);
        const row = await groupMembershipStore.getRow(identity.groupId, identity.userId);
        return row ? { id: encodeGroupMembershipRowId(row), ...row } : null;
      },
      createRow: async (value) => {
        const parsed = groupMembershipRowSchema.parse(value) as GroupMembershipRow;
        const row = await groupMembershipStore.createRow(parsed);
        return { id: encodeGroupMembershipRowId(row), ...row };
      },
      patchRow: async (rowId, input) => {
        const identity = decodeGroupMembershipRowId(rowId);
        const current = await groupMembershipStore.getRow(identity.groupId, identity.userId);
        if (!current) {
          throw new Error(`Group membership ${identity.groupId}:${identity.userId} not found`);
        }
        const parsed = groupMembershipRowSchema.parse({ ...current, ...input.patch, ...identity }) as GroupMembershipRow;
        if (parsed.groupId !== identity.groupId || parsed.userId !== identity.userId) {
          throw new Error("Group membership row id cannot be changed");
        }
        const row = await groupMembershipStore.patchRow(parsed.groupId, parsed.userId, {
          isMember: parsed.isMember,
          verifiedAt: parsed.verifiedAt
        });
        return { id: encodeGroupMembershipRowId(row), ...row };
      },
      deleteRow: async (rowId) => {
        const identity = decodeGroupMembershipRowId(rowId);
        await groupMembershipStore.deleteRow(identity.groupId, identity.userId);
      }
    }
  };
}

function encodeGroupMembershipRowId(row: Pick<GroupMembershipRow, "groupId" | "userId">): string {
  return Buffer.from(JSON.stringify({
    groupId: row.groupId,
    userId: row.userId
  }), "utf8").toString("base64url");
}

function decodeGroupMembershipRowId(rowId: string): Pick<GroupMembershipRow, "groupId" | "userId"> {
  const parsed = JSON.parse(Buffer.from(rowId, "base64url").toString("utf8")) as unknown;
  const row = groupMembershipRowSchema.parse({
    ...(parsed && typeof parsed === "object" ? parsed : {}),
    isMember: false,
    verifiedAt: 0
  }) as GroupMembershipRow;
  return { groupId: row.groupId, userId: row.userId };
}

function createUsersResource(
  userStore: Pick<UserStore, "listRows" | "getPersistedRow" | "createPersistedRow" | "patchPersistedRow" | "deletePersistedRow">
): DataResourceDefinition {
  const rowSchemaMeta = exportSchemaMeta(persistedUserSchema);
  return {
    key: "users",
    title: "用户列表",
    shape: "collection",
    editable: true,
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "state.users",
      tables: ["users", "user_memories"]
    },
    rowSchemaMeta,
    rowUiTree: buildUiTreeFromMeta(rowSchemaMeta),
    export: { enabled: true, fileName: "users.json", format: "json" },
    rowIdentity: {
      fields: ["userId"],
      encode: "single"
    },
    adapter: {
      listRows: async (query) => {
        const result = await userStore.listRows({
          ...(query.offset !== undefined ? { offset: query.offset } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {})
        });
        return {
          ...result,
          rows: result.rows.map((row) => ({
            id: row.userId,
            ...row
          }))
        };
      },
      exportRows: async (query) => userStore.listRows({
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {})
      }),
      getRow: async (rowId) => {
        const row = await userStore.getPersistedRow(rowId);
        return row ? { id: row.userId, ...row } : null;
      },
      createRow: async (value) => {
        const row = await userStore.createPersistedRow(value);
        return { id: row.userId, ...row };
      },
      patchRow: async (rowId, input) => {
        const row = await userStore.patchPersistedRow(rowId, input.patch);
        return { id: row.userId, ...row };
      },
      deleteRow: async (rowId) => {
        await userStore.deletePersistedRow(rowId);
      }
    }
  };
}

function createPersonaResource(personaStore: Pick<PersonaStore, "get" | "write">): DataResourceDefinition {
  const schemaMeta = exportSchemaMeta(personaSchema);
  return {
    key: "persona",
    title: "全局人格",
    shape: "singleton",
    editable: true,
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "state.persona",
      tables: ["persona"]
    },
    schemaMeta,
    uiTree: buildUiTreeFromMeta(schemaMeta),
    export: {
      enabled: true,
      fileName: "persona.json",
      format: "json"
    },
    adapter: {
      get: async () => personaStore.get(),
      patch: async (value) => {
        const parsed = personaSchema.parse(value);
        await personaStore.write(parsed);
        return personaStore.get();
      }
    }
  };
}

const whitelistRowSchema = s.object({
  targetType: s.enum(["user", "group"] as const).title("目标类型"),
  targetId: s.string().trim().nonempty().title("目标 ID"),
  createdAtMs: s.number().int().min(0).title("创建时间").default(() => Date.now())
}).title("白名单条目")
  .strict();

type WhitelistRow = {
  targetType: "user" | "group";
  targetId: string;
  createdAtMs: number;
};

function createWhitelistResource(
  whitelistStore: Pick<WhitelistStore, "listEntries" | "upsertEntry" | "deleteEntry">
): DataResourceDefinition {
  const rowSchemaMeta = exportSchemaMeta(whitelistRowSchema);
  return {
    key: "whitelist",
    title: "白名单",
    shape: "collection",
    editable: true,
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "state.whitelist",
      tables: ["whitelist_entries"]
    },
    rowSchemaMeta,
    rowUiTree: buildUiTreeFromMeta(rowSchemaMeta),
    export: { enabled: true, fileName: "whitelist.json", format: "json" },
    rowIdentity: {
      fields: ["targetType", "targetId"],
      encode: "json_base64url"
    },
    adapter: {
      listRows: async (query) => {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        const allRows = await whitelistStore.listEntries();
        return {
          rows: allRows.slice(offset, offset + limit).map((row) => ({
            id: encodeWhitelistRowId(row),
            ...row
          })),
          total: allRows.length,
          offset,
          limit
        };
      },
      exportRows: async (query) => {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        const allRows = await whitelistStore.listEntries();
        return {
          rows: allRows.slice(offset, offset + limit),
          total: allRows.length,
          offset,
          limit
        };
      },
      getRow: async (rowId) => {
        const identity = decodeWhitelistRowId(rowId);
        const row = (await whitelistStore.listEntries())
          .find((entry) => entry.targetType === identity.targetType && entry.targetId === identity.targetId);
        return row ? { id: encodeWhitelistRowId(row), ...row } : null;
      },
      createRow: async (value) => {
        const parsed = whitelistRowSchema.parse(value) as WhitelistRow;
        const row = await whitelistStore.upsertEntry(parsed.targetType, parsed.targetId);
        return { id: encodeWhitelistRowId(row), ...row };
      },
      deleteRow: async (rowId) => {
        const identity = decodeWhitelistRowId(rowId);
        await whitelistStore.deleteEntry(identity.targetType, identity.targetId);
      }
    }
  };
}

function encodeWhitelistRowId(row: Pick<WhitelistRow, "targetType" | "targetId">): string {
  return Buffer.from(JSON.stringify({
    targetType: row.targetType,
    targetId: row.targetId
  }), "utf8").toString("base64url");
}

function decodeWhitelistRowId(rowId: string): Pick<WhitelistRow, "targetType" | "targetId"> {
  const parsed = JSON.parse(Buffer.from(rowId, "base64url").toString("utf8")) as unknown;
  const row = whitelistRowSchema.parse({
    ...(parsed && typeof parsed === "object" ? parsed : {}),
    createdAtMs: 0
  }) as WhitelistRow;
  return {
    targetType: row.targetType,
    targetId: row.targetId
  };
}

function createContextItemsResource(
  contextStore: Pick<ContextStore, "listContextItems" | "getContextItem">
): DataResourceDefinition {
  return {
    key: "context_items",
    title: "上下文记忆条目",
    shape: "collection",
    editable: false,
    durability: "source_of_truth",
    storage: {
      kind: "sqlite",
      database: "context",
      tableGroup: "context.items",
      tables: ["context_items", "context_item_sources"]
    },
    rowIdentity: { fields: ["itemId"], encode: "single" },
    export: { enabled: true, fileName: "context_items.json", format: "json" },
    adapter: {
      listRows: async (query) => {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        const result = contextStore.listContextItems({ offset, limit });
        return {
          rows: result.items.map((item) => rowWithId(item.itemId, item)),
          total: result.total,
          offset,
          limit
        };
      },
      exportRows: async (query) => {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 500;
        const result = contextStore.listContextItems({ offset, limit });
        return {
          rows: result.items,
          total: result.total,
          offset,
          limit
        };
      },
      getRow: async (rowId) => {
        const item = contextStore.getContextItem(rowId);
        return item ? rowWithId(item.itemId, item) : null;
      }
    }
  };
}

function createContextRawMessagesResource(
  contextStore: Pick<ContextStore, "listRawMessages">
): DataResourceDefinition {
  return {
    key: "context_raw_messages",
    title: "上下文原始消息",
    shape: "log",
    editable: false,
    durability: "derived",
    storage: {
      kind: "sqlite",
      database: "context",
      tableGroup: "context.raw_messages",
      tables: ["raw_messages"]
    },
    export: { enabled: false, fileName: "context_raw_messages.json", format: "json" },
    adapter: {
      listRows: async (query) => {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        const result = contextStore.listRawMessages({ offset, limit });
        return {
          rows: result.rows.map((row) => rowWithId((row as { message_id: string }).message_id, row)),
          total: result.total,
          offset,
          limit
        };
      }
    }
  };
}

function createContextMaintenanceJobsResource(
  contextStore: Pick<ContextStore, "listMaintenanceJobs">
): DataResourceDefinition {
  return {
    key: "context_maintenance_jobs",
    title: "上下文维护任务日志",
    shape: "log",
    editable: false,
    durability: "derived",
    storage: {
      kind: "sqlite",
      database: "context",
      tableGroup: "context.maintenance",
      tables: ["maintenance_jobs"]
    },
    export: { enabled: false, fileName: "context_maintenance_jobs.json", format: "json" },
    adapter: {
      listRows: async (query) => {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        const result = contextStore.listMaintenanceJobs({ offset, limit });
        return {
          rows: result.rows.map((row) => rowWithId((row as { job_id: string }).job_id, row)),
          total: result.total,
          offset,
          limit
        };
      }
    }
  };
}

function rowWithId(id: string, row: unknown): unknown {
  return { id, ...(row as Record<string, unknown>) };
}

function createLiveResourcesResource(
  runtimeResourceStore: Pick<RuntimeResourceStore, "listRows" | "list">
): DataResourceDefinition {
  return {
    key: "live_resources",
    title: "运行时资源",
    shape: "collection",
    editable: false,
    durability: "cache",
    storage: {
      kind: "sqlite",
      database: "state",
      tableGroup: "state.runtime_resources",
      tables: ["runtime_resources", "runtime_browser_pages", "runtime_shell_sessions"]
    },
    export: { enabled: true, fileName: "live_resources.json", format: "json" },
    rowIdentity: { fields: ["resourceId"], encode: "single" },
    adapter: {
      listRows: async (query) => {
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 100;
        const all = await runtimeResourceStore.list();
        return {
          rows: all.slice(offset, offset + limit).map((row) => rowWithId(row.resourceId, row)),
          total: all.length,
          offset,
          limit
        };
      },
      getRow: async (rowId) => {
        const all = await runtimeResourceStore.list();
        const row = all.find((r) => r.resourceId === rowId);
        return row ? rowWithId(row.resourceId, row) : null;
      }
    }
  };
}

function fileResource(input: {
  key: string;
  title: string;
  path: string;
  durability: DataResourceDefinition["durability"];
}): DataResourceDefinition {
  return {
    key: input.key,
    title: input.title,
    shape: "file",
    editable: false,
    durability: input.durability,
    storage: {
      kind: "file",
      path: input.path
    },
    adapter: {
      get: async () => readOptionalStructuredFile(input.path)
    }
  };
}

function directoryResource(input: {
  key: string;
  title: string;
  path: string;
  durability: DataResourceDefinition["durability"];
}): DataResourceDefinition {
  return {
    key: input.key,
    title: input.title,
    shape: "directory",
    editable: false,
    durability: input.durability,
    storage: {
      kind: "file",
      path: input.path
    },
    adapter: {
      listItems: async () => listDirectoryItems(input.path),
      getItem: async (itemKey) => {
        const items = await listDirectoryItems(input.path);
        const item = items.find((entry) => entry.key === itemKey);
        if (!item?.path) {
          return null;
        }
        return {
          resourceKey: input.key,
          ...item,
          value: await readOptionalStructuredFile(item.path)
        };
      }
    }
  };
}

async function readOptionalStructuredFile(filePath: string): Promise<unknown> {
  try {
    return await readStructuredFileRaw(filePath);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function listDirectoryItems(dirPath: string): Promise<Array<{
  key: string;
  title: string;
  path: string;
  size: number;
  updatedAt: number;
}>> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const filePath = join(dirPath, entry.name);
          const fileStat = await stat(filePath);
          return {
            key: entry.name,
            title: decodeURIComponent(entry.name.replace(/\.json$/i, "")),
            path: filePath,
            size: fileStat.size,
            updatedAt: fileStat.mtimeMs
          };
        })
    );
    return files.sort((left, right) => left.key.localeCompare(right.key));
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
