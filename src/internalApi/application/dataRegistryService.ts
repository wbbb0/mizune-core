import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "#config/config.ts";
import { DataRegistry, type DataResourceDefinition } from "#data/registry/index.ts";
import { s } from "#data/schema/index.ts";
import { exportSchemaMeta } from "#data/schema/composites.ts";
import { readStructuredFileRaw } from "#data/schema/file.ts";
import { buildUiTreeFromMeta } from "#data/schema/ui.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";
import { personaSchema } from "#persona/personaSchema.ts";
import type { PersonaStore } from "#persona/personaStore.ts";

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
  config: Pick<AppConfig, "dataDir">;
  personaStore: Pick<PersonaStore, "get" | "write">;
  whitelistStore: Pick<WhitelistStore, "listEntries" | "upsertEntry" | "deleteEntry">;
}): DataRegistryService {
  const registry = new DataRegistry();
  for (const definition of createInitialDataResourceDefinitions(input)) {
    registry.register(definition);
  }
  return registry;
}

function createInitialDataResourceDefinitions(input: {
  config: Pick<AppConfig, "dataDir">;
  personaStore: Pick<PersonaStore, "get" | "write">;
  whitelistStore: Pick<WhitelistStore, "listEntries" | "upsertEntry" | "deleteEntry">;
}): DataResourceDefinition[] {
  const dataDir = input.config.dataDir;
  return [
    createPersonaResource(input.personaStore),
    createWhitelistResource(input.whitelistStore),
    fileResource({
      key: "audio_files",
      title: "Audio Files",
      path: join(dataDir, "audio-files.json"),
      durability: "derived"
    }),
    fileResource({
      key: "image_files",
      title: "Image Files",
      path: join(dataDir, "image-files.json"),
      durability: "derived"
    }),
    directoryResource({
      key: "sessions",
      title: "Sessions",
      path: join(dataDir, "sessions"),
      durability: "source_of_truth"
    }),
    fileResource({
      key: "workspace_files",
      title: "Workspace Files",
      path: join(dataDir, "workspace", "files.json"),
      durability: "derived"
    })
  ];
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
