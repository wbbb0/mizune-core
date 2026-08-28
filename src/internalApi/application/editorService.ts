import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { AppConfig } from "#config/config.ts";
import {
  fileConfigSchema,
  llmCatalogFileSchema,
  llmRoutingPresetCatalogFileSchema
} from "#config/configModel.ts";
import type { ConfigRuntime } from "#config/configModel.ts";
import {
  applyLlmCatalogProviderMutations,
  summarizeLlmProviderMutationImpact,
  validateLlmCatalogProviderMutations,
  type LlmCatalogProviderMutation,
  type LlmProviderMutationImpact
} from "#config/llmCatalogMutations.ts";
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
  normalizable?: boolean;
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

export class EditorRevisionConflictError extends Error {
  public constructor(message = "LLM 配置已被其他保存更新，请重新读取后再保存") {
    super(message);
    this.name = "EditorRevisionConflictError";
  }
}

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
  saveDraft(resourceKey: string, value: unknown, mutations?: LlmCatalogProviderMutation[], revision?: string): Promise<{
    ok: true;
    path: string;
    parsed: unknown;
  }>;
  getLlmProviderImpact(provider: string): Promise<LlmProviderMutationImpact>;
  normalizeDraft(resourceKey: string, value: unknown): Promise<{
    ok: true;
    path: string;
    parsed: unknown;
  }>;
  getOptions(optionKey: string): Promise<{
    options: string[];
  } | {
    groups: Array<{
      key: string;
      label: string;
      options: Array<{
        key: string;
        label: string;
        value: unknown;
        description?: string;
        disabled?: boolean;
      }>;
    }>;
  }>;
}

export function createEditorService(input: {
  config: Pick<AppConfig, "configRuntime" | "dataDir">;
  configManager: Pick<ConfigManager, "checkForUpdates" | "runWriteTransaction">;
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
      const schemaDefaultValue = createSchemaDefaultValue(resource.schema);
      const editorFeatures = resolveEditorFeatures(resource);

      if (resource.kind === "single") {
        const revisioned = isLinkedLlmResource(resourceKey)
          ? await readRevisionedLlmResource(resource, input.config.configRuntime)
          : { current: await readSingleResource(resource), revision: undefined };
        const current = revisioned.current;
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
            schemaDefaultValue,
            currentValue: valueState.currentValue,
            referenceValue: valueState.referenceValue,
            effectiveValue: valueState.effectiveValue,
            editorFeatures,
            ...(revisioned.revision ? { revision: revisioned.revision } : {}),
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
          schemaDefaultValue,
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

    async saveDraft(resourceKey, value, mutations = [], revision) {
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
        if (resourceKey === "llm_catalog") {
          await saveLlmCatalogDraft({
            configRuntime: input.config.configRuntime,
            configManager: input.configManager,
            value: valueState.currentValue,
            mutations,
            revision
          });
          return {
            ok: true as const,
            path: resource.filePath,
            parsed: valueState.currentValue
          };
        }
        if (resourceKey === "llm_routing_preset_catalog") {
          await input.configManager.runWriteTransaction(async () => {
            await assertLlmRevision(input.config.configRuntime, revision);
            await writeConfigFile(resource.filePath, valueState.currentValue);
          });
          return {
            ok: true as const,
            path: resource.filePath,
            parsed: valueState.currentValue
          };
        }
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

    async getLlmProviderImpact(provider) {
      const [catalogRaw, routingRaw] = await Promise.all([
        readConfigFileRaw(input.config.configRuntime.llmCatalogPath).catch(() => ({})),
        readConfigFileRaw(input.config.configRuntime.llmRoutingPresetCatalogPath).catch(() => ({}))
      ]);
      const catalog = parseConfig(llmCatalogFileSchema, catalogRaw, { cloneInput: true });
      const routingPresets = parseConfig(llmRoutingPresetCatalogFileSchema, routingRaw, { cloneInput: true });
      return summarizeLlmProviderMutationImpact(catalog, routingPresets, provider);
    },

    async normalizeDraft(resourceKey, value) {
      const resources = buildEditorResourceMap(input);
      const resource = getRequiredResource(resources, resourceKey);
      if (!resource.editable) {
        throw new Error(`Editor resource is read-only: ${resourceKey}`);
      }
      if (!resource.normalizable) {
        throw new Error(`Editor resource cannot be normalized: ${resourceKey}`);
      }
      if (resource.kind !== "single") {
        throw new Error(`Editor resource cannot be normalized directly: ${resourceKey}`);
      }

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
    },

    async getOptions(optionKey) {
      if (optionKey === "llm_model_targets") {
        const raw = await readConfigFileRaw(input.config.configRuntime.llmCatalogPath).catch(() => ({}));
        const catalog = parseConfig(llmCatalogFileSchema, raw, { cloneInput: true });
        return {
          groups: Object.entries(catalog)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([provider, providerConfig]) => ({
              key: provider,
              label: provider,
              options: Object.entries(providerConfig.models)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([model, profile]) => ({
                  key: model,
                  label: `${model} · ${profile.upstreamModel}`,
                  value: { provider, model },
                  description: profile.upstreamModel
                }))
            }))
        };
      }

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
      key: "global_config",
      title: "全局运行时配置",
      domain: "config",
      kind: "single",
      editable: true,
      normalizable: true,
      schema: fileConfigSchema,
      filePath: input.config.configRuntime.globalConfigPath,
      editorFeatures: createEditorFeatures({
        unsetMode: "optional",
        draftEffectiveMode: "draft_only"
      }),
      afterSave: async () => {
        await input.configManager.checkForUpdates();
      }
    },
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
      key: "llm_catalog",
      title: "LLM Provider 与模型目录",
      domain: "config",
      kind: "single",
      editable: true,
      schema: llmCatalogFileSchema,
      filePath: input.config.configRuntime.llmCatalogPath,
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
      schema: llmRoutingPresetCatalogFileSchema,
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
  const dataResources: EditorResource<any>[] = [];

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

function isLinkedLlmResource(resourceKey: string): boolean {
  return resourceKey === "llm_catalog" || resourceKey === "llm_routing_preset_catalog";
}

async function readRevisionedLlmResource<TSchema extends BaseSchema<any>>(
  resource: SingleFileEditorResource<TSchema>,
  configRuntime: ConfigRuntime
): Promise<{ current: Infer<TSchema>; revision: string }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await computeLlmConfigRevision(configRuntime);
    const current = await readSingleResource(resource);
    const after = await computeLlmConfigRevision(configRuntime);
    if (before === after) {
      return { current, revision: after };
    }
  }
  throw new EditorRevisionConflictError("LLM 配置正在变化，请稍后重新读取");
}

async function assertLlmRevision(configRuntime: ConfigRuntime, expectedRevision: string | undefined): Promise<void> {
  if (!expectedRevision || expectedRevision !== await computeLlmConfigRevision(configRuntime)) {
    throw new EditorRevisionConflictError();
  }
}

async function computeLlmConfigRevision(configRuntime: ConfigRuntime): Promise<string> {
  const hash = createHash("sha256");
  for (const filePath of [configRuntime.llmCatalogPath, configRuntime.llmRoutingPresetCatalogPath]) {
    try {
      const content = await readFile(filePath);
      hash.update(String(content.length));
      hash.update(":");
      hash.update(content);
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
      hash.update("missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
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

function createSchemaDefaultValue<TSchema extends BaseSchema<any>>(schema: TSchema): unknown {
  const template = createSchemaTemplate(schema);
  try {
    return parseConfig(schema, template, { cloneInput: true });
  } catch {
    return template;
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
    case "llm_provider_names": return configRuntime.llmCatalogPath;
    case "llm_routing_preset_names": return configRuntime.llmRoutingPresetCatalogPath;
    default: return null;
  }
}

async function saveLlmCatalogDraft(input: {
  configRuntime: ConfigRuntime;
  configManager: Pick<ConfigManager, "runWriteTransaction">;
  value: unknown;
  mutations: LlmCatalogProviderMutation[];
  revision: string | undefined;
}): Promise<void> {
  const nextCatalog = parseConfig(llmCatalogFileSchema, input.value, { cloneInput: true });

  await input.configManager.runWriteTransaction(async () => {
    await assertLlmRevision(input.configRuntime, input.revision);
    const [previousCatalogRaw, previousRoutingRaw] = await Promise.all([
      readConfigFileRaw(input.configRuntime.llmCatalogPath).catch(() => ({})),
      readConfigFileRaw(input.configRuntime.llmRoutingPresetCatalogPath).catch(() => ({}))
    ]);
    const previousCatalog = parseConfig(llmCatalogFileSchema, previousCatalogRaw, { cloneInput: true });
    const previousRouting = parseConfig(llmRoutingPresetCatalogFileSchema, previousRoutingRaw, { cloneInput: true });

    validateLlmCatalogProviderMutations(previousCatalog, nextCatalog, input.mutations);
    const nextRouting = applyLlmCatalogProviderMutations(previousRouting, input.mutations);

    await writeConfigFile(input.configRuntime.llmCatalogPath, nextCatalog);
    if (input.mutations.length === 0) {
      return;
    }

    try {
      await writeConfigFile(input.configRuntime.llmRoutingPresetCatalogPath, nextRouting);
    } catch (error) {
      try {
        await writeConfigFile(input.configRuntime.llmCatalogPath, previousCatalog);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Failed to update LLM routing after catalog mutation and failed to restore the catalog"
        );
      }
      throw error;
    }
  });
}
