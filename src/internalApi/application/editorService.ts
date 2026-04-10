import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "#config/config.ts";
import { fileConfigSchema, llmModelCatalogSchema, llmProviderCatalogSchema } from "#config/configModel.ts";
import type { ConfigRuntime } from "#config/configModel.ts";
import { s } from "#data/schema/index.ts";
import { createSchemaTemplate, exportSchemaMeta } from "#data/schema/composites.ts";
import {
  parseConfig,
  readConfigFileRaw,
  readStructuredFileRaw,
  writeConfigFile
} from "#data/schema/file.ts";
import { deepMergeAllReplaceArrays } from "#data/schema/helpers.ts";
import { buildUiTreeFromMeta } from "#data/schema/ui.ts";
import type { BaseSchema, Infer } from "#data/schema/index.ts";
import { personaSchema } from "#persona/personaSchema.ts";
import { memoryEntrySchema } from "#memory/memoryEntry.ts";
import { userStoreSchema } from "#identity/userSchema.ts";
import { whitelistFileSchema } from "#identity/whitelistSchema.ts";
import { requestFileSchema } from "#requests/requestSchema.ts";
import { setupStateSchema } from "#identity/setupStateSchema.ts";
import { membershipFileSchema } from "#identity/groupMembershipSchema.ts";
import { runtimeResourceFileSchema } from "#runtime/resources/runtimeResourceSchema.ts";
import { scheduledJobFileSchema } from "#runtime/scheduler/jobSchema.ts";
import { operationNoteFileSchema } from "#llm/prompt/operationNoteStore.ts";
import type { ConfigManager } from "#config/configManager.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";
import type { Scheduler } from "#runtime/scheduler/scheduler.ts";

interface BaseEditorResource<TSchema extends BaseSchema<any>> {
  key: string;
  title: string;
  domain: "config" | "data";
  schema: TSchema;
  editable: boolean;
}

interface SingleFileEditorResource<TSchema extends BaseSchema<any>> extends BaseEditorResource<TSchema> {
  kind: "single";
  filePath: string;
  afterSave?: () => Promise<void> | void;
}

interface LayeredEditorResource<TSchema extends BaseSchema<any>> extends BaseEditorResource<TSchema> {
  kind: "layered";
  layers: Array<{
    key: string;
    path: string;
    optional?: boolean;
  }>;
  writableLayerKey: string;
  layerFeatures?: {
    showBackdrop?: boolean;
    allowRestoreInherited?: boolean;
  };
  afterSave?: () => Promise<void> | void;
}

type EditorResource<TSchema extends BaseSchema<any>> =
  | SingleFileEditorResource<TSchema>
  | LayeredEditorResource<TSchema>;

export interface EditorService {
  listResources(): Promise<{
    resources: Array<{
      key: string;
      title: string;
      domain: "config" | "data";
      kind: "single" | "layered";
      editable: boolean;
    }>;
  }>;
  loadResourceModel(resourceKey: string): Promise<{
    editor: unknown;
  }>;
  validateDraft(resourceKey: string, value: unknown): Promise<{
    ok: true;
    parsed: unknown;
    current: unknown;
    effective: unknown;
  }>;
  saveDraft(resourceKey: string, value: unknown): Promise<{
    ok: true;
    path: string;
    parsed: unknown;
  }>;
  getOptions(optionKey: string): Promise<{
    options: string[];
  }>;
}

export function createEditorService(input: {
  config: Pick<AppConfig, "configRuntime" | "dataDir">;
  configManager: Pick<ConfigManager, "checkForUpdates">;
  whitelistStore: Pick<WhitelistStore, "reloadFromDisk">;
  scheduler: Pick<Scheduler, "reloadFromStore">;
}): EditorService {
  return {
    async listResources() {
      const resources = buildEditorResourceMap(input);
      return {
        resources: Array.from(resources.values())
          .map((resource) => ({
            key: resource.key,
            title: resource.title,
            domain: resource.domain,
            kind: resource.kind,
            editable: resource.editable
          }))
          .sort((left, right) => left.key.localeCompare(right.key))
      };
    },

    async loadResourceModel(resourceKey) {
      const resources = buildEditorResourceMap(input);
      const resource = getRequiredResource(resources, resourceKey);
      const schemaMeta = exportSchemaMeta(resource.schema);

      if (resourceKey === "config" && schemaMeta.kind === "object") {
        delete schemaMeta.fields.comfy;
      }

      const template = createSchemaTemplate(resource.schema);

      if (resource.kind === "single") {
        const current = await readSingleResource(resource);
        return {
          editor: {
            key: resource.key,
            title: resource.title,
            kind: resource.kind,
            editable: resource.editable,
            schemaMeta,
            uiTree: buildUiTreeFromMeta(schemaMeta),
            template,
            current,
            file: {
              path: resource.filePath
            }
          }
        };
      }

      const layers = await Promise.all(resource.layers.map(async (layer) => ({
        key: layer.key,
        path: layer.path,
        value: await readOptionalConfigLayer(layer.path)
      })));
      const writableLayer = layers.find((layer) => layer.key === resource.writableLayerKey);
      const baseValue = deepMergeAllReplaceArrays(
        layers
          .filter((layer) => layer.key !== resource.writableLayerKey)
          .map((layer) => layer.value)
      );
      const effectiveValue = parseConfig(resource.schema, deepMergeAllReplaceArrays([
        baseValue,
        writableLayer?.value ?? {}
      ]));
      return {
        editor: {
          key: resource.key,
          title: resource.title,
          kind: resource.kind,
          editable: resource.editable,
          schemaMeta,
          uiTree: buildUiTreeFromMeta(schemaMeta),
          template,
          baseValue,
          currentValue: writableLayer?.value ?? {},
          effectiveValue,
          writableLayerKey: resource.writableLayerKey,
          layerFeatures: {
            showBackdrop: resource.layerFeatures?.showBackdrop ?? false,
            allowRestoreInherited: resource.layerFeatures?.allowRestoreInherited ?? false
          },
          layers
        }
      };
    },

    async validateDraft(resourceKey, value) {
      const resources = buildEditorResourceMap(input);
      const resource = getRequiredResource(resources, resourceKey);
      if (resource.kind === "single") {
        return {
          ok: true as const,
          parsed: parseConfig(resource.schema, value, { cloneInput: true }),
          current: await readSingleResource(resource),
          effective: value
        };
      }

      const readonlyLayers = await Promise.all(
        resource.layers
          .filter((layer) => layer.key !== resource.writableLayerKey)
          .map(async (layer) => readOptionalConfigLayer(layer.path))
      );
      const parsed = parseConfig(resource.schema, deepMergeAllReplaceArrays([
        ...readonlyLayers,
        value as Record<string, unknown>
      ]), {
        cloneInput: true
      });
      const writableLayer = resource.layers.find((layer) => layer.key === resource.writableLayerKey);
      const current = writableLayer ? await readOptionalConfigLayer(writableLayer.path) : {};
      return {
        ok: true as const,
        parsed,
        current,
        effective: parsed
      };
    },

    async saveDraft(resourceKey, value) {
      const resources = buildEditorResourceMap(input);
      const resource = getRequiredResource(resources, resourceKey);
      if (!resource.editable) {
        throw new Error(`Editor resource is read-only: ${resourceKey}`);
      }

      if (resource.kind === "single") {
        const parsed = parseConfig(resource.schema, value, { cloneInput: true });
        await writeConfigFile(resource.filePath, parsed);
        await resource.afterSave?.();
        return {
          ok: true as const,
          path: resource.filePath,
          parsed
        };
      }

      const writableLayer = resource.layers.find((layer) => layer.key === resource.writableLayerKey);
      if (!writableLayer) {
        throw new Error(`Missing writable layer for editor resource: ${resourceKey}`);
      }
      const readonlyLayers = await Promise.all(
        resource.layers
          .filter((layer) => layer.key !== resource.writableLayerKey)
          .map(async (layer) => readOptionalConfigLayer(layer.path))
      );
      const parsed = parseConfig(resource.schema, deepMergeAllReplaceArrays([
        ...readonlyLayers,
        value as Record<string, unknown>
      ]), {
        cloneInput: true
      });
      await writeConfigFile(writableLayer.path, value);
      await resource.afterSave?.();
      return {
        ok: true as const,
        path: writableLayer.path,
        parsed
      };
    },

    async getOptions(optionKey) {
      const catalogPath = resolveDynamicRefCatalogPath(input.config.configRuntime, optionKey);
      if (!catalogPath) {
        throw new Error(`Unknown editor option key: ${optionKey}`);
      }
      const raw = await readConfigFileRaw(catalogPath).catch(() => ({}));
      return { options: Object.keys(raw).sort() };
    }
  };
}

function buildEditorResourceMap(input: {
  config: Pick<AppConfig, "configRuntime" | "dataDir">;
  configManager: Pick<ConfigManager, "checkForUpdates">;
  whitelistStore: Pick<WhitelistStore, "reloadFromDisk">;
  scheduler: Pick<Scheduler, "reloadFromStore">;
}): Map<string, EditorResource<any>> {
  const configResources: EditorResource<any>[] = [
    {
      key: "config",
      title: "运行时配置",
      domain: "config",
      kind: "layered",
      editable: true,
      schema: fileConfigSchema,
      writableLayerKey: "instance",
      layerFeatures: {
        showBackdrop: true,
        allowRestoreInherited: true
      },
      layers: [
        { key: "global", path: input.config.configRuntime.globalConfigPath, optional: true },
        { key: "instance", path: input.config.configRuntime.instanceConfigPath }
      ],
      afterSave: async () => {
        await input.configManager.checkForUpdates();
      }
    },
    {
      key: "llm_provider_catalog",
      title: "LLM Provider Catalog",
      domain: "config",
      kind: "single",
      editable: true,
      schema: llmProviderCatalogSchema,
      filePath: input.config.configRuntime.llmProviderCatalogPath,
      afterSave: async () => {
        await input.configManager.checkForUpdates();
      }
    },
    {
      key: "llm_model_catalog",
      title: "LLM Model Catalog",
      domain: "config",
      kind: "single",
      editable: true,
      schema: llmModelCatalogSchema,
      filePath: input.config.configRuntime.llmModelCatalogPath,
      afterSave: async () => {
        await input.configManager.checkForUpdates();
      }
    }
  ];
  const dataDir = input.config.dataDir;
  const dataResources: EditorResource<any>[] = [
    single("persona", "Persona", "data", personaSchema, `${dataDir}/persona.json`),
    single("users", "Users", "data", userStoreSchema, `${dataDir}/users.json`),
    single("whitelist", "Whitelist", "data", whitelistFileSchema, `${dataDir}/whitelist.json`, {
      afterSave: async () => {
        await input.whitelistStore.reloadFromDisk();
      }
    }),
    single("requests", "Pending Requests", "data", requestFileSchema, `${dataDir}/pending-requests.json`),
    single("setup_state", "Setup State", "data", setupStateSchema, `${dataDir}/setup-state.json`),
    single("group_membership", "Group Membership Cache", "data", membershipFileSchema, `${dataDir}/group-membership-cache.json`),
    single("live_resources", "Live Resources", "data", runtimeResourceFileSchema, `${dataDir}/live-resources.json`, {
      editable: false
    }),
    single("scheduled_jobs", "Scheduled Jobs", "data", scheduledJobFileSchema, `${dataDir}/scheduled-jobs.json`, {
      afterSave: async () => {
        await input.scheduler.reloadFromStore();
      }
    }),
    single("global_memories", "Global Memories", "data", s.array(memoryEntrySchema).default([]), `${dataDir}/global-memories.json`),
    single("operation_notes", "Operation Notes", "data", operationNoteFileSchema, `${dataDir}/operation-notes.json`)
  ];

  return new Map(
    [...configResources, ...dataResources].map((resource) => [resource.key, resource])
  );
}

function single<TSchema extends BaseSchema<any>>(
  key: string,
  title: string,
  domain: "config" | "data",
  schema: TSchema,
  filePath: string,
  options?: {
    editable?: boolean;
    afterSave?: () => Promise<void> | void;
  }
): SingleFileEditorResource<TSchema> {
  return {
    key,
    title,
    domain,
    kind: "single",
    editable: options?.editable ?? true,
    schema,
    filePath,
    ...(options?.afterSave ? { afterSave: options.afterSave } : {})
  };
}

async function readSingleResource<TSchema extends BaseSchema<any>>(
  resource: SingleFileEditorResource<TSchema>
): Promise<Infer<TSchema>> {
  try {
    return parseConfig(resource.schema, await readStructuredFileRaw(resource.filePath));
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return parseConfig(resource.schema, createSchemaTemplate(resource.schema));
    }
    throw error;
  }
}

function getRequiredResource(
  resources: Map<string, EditorResource<any>>,
  resourceKey: string
): EditorResource<any> {
  const resource = resources.get(resourceKey);
  if (!resource) {
    throw new Error(`Unknown editor resource: ${resourceKey}`);
  }
  return resource;
}

async function readOptionalConfigLayer(filePath: string): Promise<Record<string, unknown>> {
  try {
    return await readConfigFileRaw(filePath);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function resolveDynamicRefCatalogPath(configRuntime: ConfigRuntime, optionKey: string): string | null {
  switch (optionKey) {
    case "llm_provider_names": return configRuntime.llmProviderCatalogPath;
    case "llm_model_names": return configRuntime.llmModelCatalogPath;
    default: return null;
  }
}
