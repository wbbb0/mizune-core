import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "#config/config.ts";
import {
  fileConfigSchema,
  llmModelCatalogSchema,
  llmProviderCatalogSchema,
  llmRoutingPresetCatalogSchema
} from "#config/configModel.ts";
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
import { rpProfileSchema } from "#modes/rpAssistant/profileSchema.ts";
import { scenarioProfileSchema } from "#modes/scenarioHost/profileSchema.ts";
import { globalRuleFileSchema } from "#memory/globalRuleEntry.ts";
import { userStoreSchema } from "#identity/userSchema.ts";
import { whitelistFileSchema } from "#identity/whitelistSchema.ts";
import { requestFileSchema } from "#requests/requestSchema.ts";
import { setupStateSchema } from "#identity/setupStateSchema.ts";
import { globalProfileReadinessSchema } from "#identity/globalProfileReadinessSchema.ts";
import { membershipFileSchema } from "#identity/groupMembershipSchema.ts";
import { runtimeResourceFileSchema } from "#runtime/resources/runtimeResourceSchema.ts";
import { scheduledJobFileSchema } from "#runtime/scheduler/jobSchema.ts";
import { toolsetRuleFileSchema } from "#llm/prompt/toolsetRuleStore.ts";
import type { ConfigManager } from "#config/configManager.ts";
import type { WhitelistStore } from "#identity/whitelistStore.ts";
import type { Scheduler } from "#runtime/scheduler/scheduler.ts";
import {
  createDraftOnlyEditorValueState,
  createEditorFeatures,
  createRoutingPresetCatalogEditorValueState,
  type EditorFeatures,
  type EditorValueState
} from "./editorValueState.ts";

interface BaseEditorResource<TSchema extends BaseSchema<any>> {
  key: string;
  title: string;
  domain: "config" | "data";
  schema: TSchema;
  editable: boolean;
  editorFeatures?: Partial<EditorFeatures>;
}

interface SingleFileEditorResource<TSchema extends BaseSchema<any>> extends BaseEditorResource<TSchema> {
  kind: "single";
  filePath: string;
  createValueState?: (currentValue: Infer<TSchema>) => EditorValueState<Infer<TSchema>>;
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
    currentValue: unknown;
    referenceValue: unknown;
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
      if (resourceKey === "users" && schemaMeta.kind === "array" && schemaMeta.item.kind === "object") {
        delete schemaMeta.item.fields.memories;
      }

      const editorTemplate = resolveEditorValueState(resource, createSchemaTemplate(resource.schema)).currentValue;
      const editorFeatures = resolveEditorFeatures(resource);

      if (resource.kind === "single") {
        const current = await readSingleResource(resource);
        const valueState = resolveEditorValueState(resource, current);
        return {
          editor: {
            key: resource.key,
            title: resource.title,
            kind: resource.kind,
            editable: resource.editable,
            schemaMeta,
            uiTree: buildUiTreeFromMeta(schemaMeta),
            template: editorTemplate,
            currentValue: valueState.currentValue,
            referenceValue: valueState.referenceValue,
            effectiveValue: valueState.effectiveValue,
            editorFeatures,
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
      const currentValue = writableLayer?.value ?? {};
      const effectiveValue = parseConfig(resource.schema, deepMergeAllReplaceArrays([
        baseValue,
        currentValue
      ]));
      return {
        editor: {
          key: resource.key,
          title: resource.title,
          kind: resource.kind,
          editable: resource.editable,
          schemaMeta,
          uiTree: buildUiTreeFromMeta(schemaMeta),
          template: editorTemplate,
          currentValue,
          referenceValue: baseValue,
          effectiveValue,
          editorFeatures,
          writableLayerKey: resource.writableLayerKey,
          layers
        }
      };
    },

    async validateDraft(resourceKey, value) {
      const resources = buildEditorResourceMap(input);
      const resource = getRequiredResource(resources, resourceKey);
      if (resource.kind === "single") {
        const valueState = resolveEditorValueState(
          resource,
          parseConfig(resource.schema, value, { cloneInput: true })
        );
        const currentValue = resolveEditorValueState(resource, await readSingleResource(resource)).currentValue;
        return {
          ok: true as const,
          parsed: valueState.currentValue,
          currentValue,
          referenceValue: valueState.referenceValue,
          effective: valueState.effectiveValue
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
        currentValue: current,
        referenceValue: deepMergeAllReplaceArrays(readonlyLayers),
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
        const valueState = resolveEditorValueState(
          resource,
          parseConfig(resource.schema, value, { cloneInput: true })
        );
        await writeConfigFile(resource.filePath, valueState.currentValue);
        await resource.afterSave?.();
        return {
          ok: true as const,
          path: resource.filePath,
          parsed: valueState.currentValue
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
      const normalizedRaw = optionKey === "llm_routing_preset_names"
        ? createRoutingPresetCatalogEditorValueState(raw as Record<string, never>).currentValue
        : raw;
      return { options: Object.keys(normalizedRaw).sort() };
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
      editorFeatures: createEditorFeatures({
        showReferenceBackdrop: true,
        unsetMode: "reference",
        unsetActionLabel: "恢复继承",
        draftEffectiveMode: "merge_reference"
      }),
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
      title: "LLM 提供方目录",
      domain: "config",
      kind: "single",
      editable: true,
      schema: llmProviderCatalogSchema,
      filePath: input.config.configRuntime.llmProviderCatalogPath,
      editorFeatures: createEditorFeatures({
        unsetMode: "optional",
        draftEffectiveMode: "draft_only"
      }),
      afterSave: async () => {
        await input.configManager.checkForUpdates();
      }
    },
    {
      key: "llm_model_catalog",
      title: "LLM 模型目录",
      domain: "config",
      kind: "single",
      editable: true,
      schema: llmModelCatalogSchema,
      filePath: input.config.configRuntime.llmModelCatalogPath,
      editorFeatures: createEditorFeatures({
        unsetMode: "optional",
        draftEffectiveMode: "draft_only"
      }),
      afterSave: async () => {
        await input.configManager.checkForUpdates();
      }
    },
    {
      key: "llm_routing_preset_catalog",
      title: "LLM 路由预设目录",
      domain: "config",
      kind: "single",
      editable: true,
      schema: llmRoutingPresetCatalogSchema,
      filePath: input.config.configRuntime.llmRoutingPresetCatalogPath,
      editorFeatures: createEditorFeatures({
        unsetMode: "reference",
        unsetActionLabel: "回退到 default",
        draftEffectiveMode: "routing_preset_catalog"
      }),
      createValueState: (currentValue) => createRoutingPresetCatalogEditorValueState(
        currentValue as Record<string, never>
      ),
      afterSave: async () => {
        await input.configManager.checkForUpdates();
      }
    }
  ];
  const dataDir = input.config.dataDir;
  const dataResources: EditorResource<any>[] = [
    single("persona", "全局人格", "data", personaSchema, `${dataDir}/persona.json`),
    single("rp_profile", "RP 全局资料", "data", rpProfileSchema, `${dataDir}/rp-profile.json`),
    single("scenario_profile", "Scenario 全局资料", "data", scenarioProfileSchema, `${dataDir}/scenario-profile.json`),
    single("global_profile_readiness", "全局资料就绪状态", "data", globalProfileReadinessSchema, `${dataDir}/global-profile-readiness.json`),
    single("users", "用户列表", "data", userStoreSchema, `${dataDir}/users.json`),
    single("whitelist", "白名单", "data", whitelistFileSchema, `${dataDir}/whitelist.json`, {
      afterSave: async () => {
        await input.whitelistStore.reloadFromDisk();
      }
    }),
    single("requests", "待处理请求", "data", requestFileSchema, `${dataDir}/pending-requests.json`),
    single("setup_state", "Owner 初始化状态", "data", setupStateSchema, `${dataDir}/setup-state.json`),
    single("group_membership", "群成员缓存", "data", membershipFileSchema, `${dataDir}/group-membership-cache.json`),
    single("live_resources", "运行时资源", "data", runtimeResourceFileSchema, `${dataDir}/live-resources.json`, {
      editable: false
    }),
    single("scheduled_jobs", "定时任务", "data", scheduledJobFileSchema, `${dataDir}/scheduled-jobs.json`, {
      afterSave: async () => {
        await input.scheduler.reloadFromStore();
      }
    }),
    single("global_rules", "全局规则列表", "data", globalRuleFileSchema, `${dataDir}/global-rules.json`),
    single("toolset_rules", "工具集规则列表", "data", toolsetRuleFileSchema, `${dataDir}/toolset-rules.json`)
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
    editorFeatures: createEditorFeatures({
      unsetMode: "optional",
      draftEffectiveMode: "draft_only"
    }),
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

function resolveEditorValueState<TSchema extends BaseSchema<any>>(
  resource: EditorResource<TSchema>,
  value: Infer<TSchema>
): EditorValueState<Infer<TSchema>> {
  if (resource.kind === "single" && resource.createValueState) {
    return resource.createValueState(value);
  }
  return createDraftOnlyEditorValueState(value);
}

function resolveEditorFeatures<TSchema extends BaseSchema<any>>(
  resource: EditorResource<TSchema>
): EditorFeatures {
  return createEditorFeatures(resource.editorFeatures);
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
    case "llm_routing_preset_names": return configRuntime.llmRoutingPresetCatalogPath;
    default: return null;
  }
}
