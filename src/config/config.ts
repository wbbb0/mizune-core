import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  configRuntimeSchema,
  fileConfigSchema,
  llmCatalogSchema,
  llmModelCatalogSchema,
  llmProviderCatalogSchema,
  llmRoutingPresetCatalogSchema,
  type ConfigRuntime,
  type ConfigSummary,
  type FileConfig,
  type LlmCatalogConfig
} from "#config/configModel.ts";
import { deepMergeAllReplaceArrays, parseConfig } from "#data/schema/index.ts";
import type { BaseSchema } from "#data/schema/base.ts";
import { ObjectSchema } from "#data/schema/composites.ts";
import { isPlainObject } from "#data/schema/helpers.ts";
import {
  getValidatedRoutingPreset,
  normalizeRoutingPresetCatalog
} from "#llm/shared/modelRouting.ts";

const envSchema = z.object({
  CONFIG_DIR: z.string().optional().describe("环境变量：配置目录路径"),
  CONFIG_INSTANCE: z.string().trim().min(1).optional().describe("环境变量：实例名称，对应 config/instances 下的文件名"),
  CONFIG_INSTANCE_FILE: z.string().trim().min(1).optional().describe("环境变量：实例配置文件路径，可为相对或绝对路径")
}).describe("环境变量配置覆盖项");

const DEFAULT_INSTANCE_NAME = "default";
const DEFAULT_DATA_DIR = "data";
const DEFAULT_LLM_PROVIDER_CATALOG_FILE = "llm.providers.yml";
const DEFAULT_LLM_MODEL_CATALOG_FILE = "llm.models.yml";
const DEFAULT_LLM_ROUTING_PRESET_CATALOG_FILE = "llm.routing-presets.yml";

export type AppConfig = Omit<FileConfig, "whitelist" | "llm"> & {
  whitelist: {
    enabled: boolean;
  };
  llm: FileConfig["llm"] & LlmCatalogConfig;
  configRuntime: ConfigRuntime;
};

function resolveConfigPath(configDir: string, filePath: string): string {
  return filePath.startsWith("/")
    ? filePath
    : resolve(configDir, filePath);
}

function loadYamlFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = YAML.parse(raw) as unknown;
    if (parsed == null) {
      return {};
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Root of config must be an object: ${filePath}`);
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    process.emitWarning(
      `Skipping unreadable config file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      "ConfigLoadWarning"
    );
    return {};
  }
}

function stripInstanceOnlyUnsupportedKeys(layer: Record<string, unknown>, sourcePath: string): Record<string, unknown> {
  if (!("comfy" in layer)) {
    return layer;
  }

  process.emitWarning(
    `Ignoring config key comfy from ${sourcePath}; ComfyUI configuration is global-only and must be placed in global.yml`,
    "ConfigLoadWarning"
  );
  const next = { ...layer };
  delete next.comfy;
  return next;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsedEnv = envSchema.parse(env);
  const configDir = parsedEnv.CONFIG_DIR != null
    ? resolve(process.cwd(), parsedEnv.CONFIG_DIR)
    : resolve(process.cwd(), "config");
  const globalExampleConfigPath = resolve(configDir, "global.example.yml");
  const globalConfigPath = resolve(configDir, "global.yml");
  const llmProviderCatalogPath = resolve(configDir, DEFAULT_LLM_PROVIDER_CATALOG_FILE);
  const llmModelCatalogPath = resolve(configDir, DEFAULT_LLM_MODEL_CATALOG_FILE);
  const llmRoutingPresetCatalogPath = resolve(configDir, DEFAULT_LLM_ROUTING_PRESET_CATALOG_FILE);
  const instanceName = parsedEnv.CONFIG_INSTANCE ?? DEFAULT_INSTANCE_NAME;
  const instanceConfigPath = parsedEnv.CONFIG_INSTANCE_FILE != null
    ? resolveConfigPath(configDir, parsedEnv.CONFIG_INSTANCE_FILE)
    : resolve(configDir, "instances", `${instanceName}.yml`);

  if (!existsSync(instanceConfigPath)) {
    throw new Error(`Missing instance config file: ${instanceConfigPath}`);
  }

  const globalConfig = sanitizeConfigLayer(loadYamlFile(globalConfigPath), globalConfigPath);
  const instanceConfig = sanitizeConfigLayer(
    stripInstanceOnlyUnsupportedKeys(loadYamlFile(instanceConfigPath), instanceConfigPath),
    instanceConfigPath
  );
  const runtimeConfig = parseConfig(fileConfigSchema, deepMergeAllReplaceArrays([
    globalConfig,
    instanceConfig
  ]));
  const llmCatalog = parseConfig(llmCatalogSchema, {
    providers: sanitizeSchemaLayer(llmProviderCatalogSchema, loadYamlFile(llmProviderCatalogPath), llmProviderCatalogPath),
    models: sanitizeSchemaLayer(llmModelCatalogSchema, loadYamlFile(llmModelCatalogPath), llmModelCatalogPath),
    routingPresets: normalizeRoutingPresetCatalog(sanitizeSchemaLayer(
      llmRoutingPresetCatalogSchema,
      loadYamlFile(llmRoutingPresetCatalogPath),
      llmRoutingPresetCatalogPath
    ) as LlmCatalogConfig["routingPresets"])
  });
  const fileConfig: AppConfig = {
    ...runtimeConfig,
    llm: {
      ...runtimeConfig.llm,
      ...llmCatalog
    },
    whitelist: {
      enabled: runtimeConfig.whitelist.enabled
    },
    configRuntime: {} as ConfigRuntime
  };
  const dataDir = normalizeDataDir(runtimeConfig.dataDir, instanceName);

  const runtime = configRuntimeSchema.parseFromObject({
    configDir,
    globalExampleConfigPath,
    globalConfigPath,
    llmProviderCatalogPath,
    llmModelCatalogPath,
    llmRoutingPresetCatalogPath,
    instanceName,
    instanceConfigPath,
    loadedConfigPaths: [
      globalConfigPath,
      llmProviderCatalogPath,
      llmModelCatalogPath,
      llmRoutingPresetCatalogPath,
      instanceConfigPath
    ].filter(
      (filePath): filePath is string => filePath != null && existsSync(filePath)
    )
  });

  fileConfig.dataDir = dataDir;
  fileConfig.configRuntime = runtime;
  emitConfigConsistencyWarnings(fileConfig);
  return fileConfig;
}

function sanitizeConfigLayer(layer: Record<string, unknown>, sourcePath: string): Record<string, unknown> {
  return sanitizeSchemaLayer(fileConfigSchema, layer, sourcePath) as Record<string, unknown>;
}

function sanitizeSchemaLayer(
  schema: BaseSchema<any>,
  layer: Record<string, unknown>,
  sourcePath: string
): unknown {
  if (schema instanceof ObjectSchema) {
    return sanitizeSchemaObject(schema, layer, sourcePath, []);
  }

  const sanitizedValue = sanitizeSchemaValue(schema, layer, sourcePath, []);
  return sanitizedValue ?? createEmptyValueForSchemaLayer();
}

function sanitizeSchemaValue(
  schema: BaseSchema<any>,
  value: unknown,
  sourcePath: string,
  path: string[]
): unknown {
  if (schema instanceof ObjectSchema) {
    if (!isPlainObject(value)) {
      emitInvalidConfigWarning(sourcePath, path, `expected object, received ${describeValueKind(value)}`);
      return undefined;
    }

    const nested = sanitizeSchemaObject(schema, value, sourcePath, path);
    try {
      schema.parse(nested, { path });
      return nested;
    } catch (error) {
      emitInvalidConfigWarning(sourcePath, path, error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  try {
    schema.parse(value, { path });
    return value;
  } catch (error) {
    emitInvalidConfigWarning(sourcePath, path, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function sanitizeSchemaObject(
  schema: ObjectSchema<any>,
  layer: Record<string, unknown>,
  sourcePath: string,
  basePath: string[]
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const shape = schema.getShape() as Record<string, BaseSchema<unknown>>;

  for (const [key, value] of Object.entries(layer)) {
    const fieldSchema = shape[key];
    const fieldPath = [...basePath, key];
    if (!fieldSchema) {
      process.emitWarning(
        `Ignoring unknown config key ${fieldPath.join(".")} from ${sourcePath}`,
        "ConfigLoadWarning"
      );
      continue;
    }

    const sanitizedValue = sanitizeSchemaValue(fieldSchema, value, sourcePath, fieldPath);
    if (sanitizedValue !== undefined) {
      sanitized[key] = sanitizedValue;
    }
  }

  return sanitized;
}

function emitInvalidConfigWarning(sourcePath: string, path: string[], details: string): void {
  process.emitWarning(
    `Ignoring invalid config value ${path.join(".")} from ${sourcePath}: ${details}`,
    "ConfigLoadWarning"
  );
}

function createEmptyValueForSchemaLayer(): Record<string, unknown> {
  return {};
}

function describeValueKind(value: unknown): string {
  if (value == null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function normalizeDataDir(dataDir: string, instanceName: string): string {
  return dataDir === DEFAULT_DATA_DIR
    ? join(DEFAULT_DATA_DIR, instanceName)
    : dataDir;
}

function emitConfigConsistencyWarnings(config: AppConfig): void {
  for (const [modelRef, profile] of Object.entries(config.llm.models)) {
    if (!(profile.provider in config.llm.providers)) {
      process.emitWarning(
        `Model ${modelRef} references unknown provider ${profile.provider}; this model will be unavailable until the provider is defined in ${config.configRuntime.llmProviderCatalogPath}`,
        "ConfigLoadWarning"
      );
    }
  }
  if (!config.llm.enabled) {
    return;
  }

  const routingPresetValidation = getValidatedRoutingPreset(config);
  for (const warning of routingPresetValidation.warnings) {
    process.emitWarning(warning, "ConfigLoadWarning");
  }
}

export function toConfigSummary(
  config: AppConfig,
  whitelistSummary?: { userWhitelistSize: number; groupWhitelistSize: number }
): ConfigSummary {
  const enabledSearchProviders = [
    ...(config.search.googleGrounding.enabled ? ["google_grounding"] : []),
    ...(config.search.aliyunIqs.enabled ? ["aliyun_iqs_lite_advanced"] : [])
  ];

  return {
    appName: config.appName,
    runtimeNodeEnv: process.env.NODE_ENV?.trim() || "unknown",
    configuredNodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    oneBotEnabled: config.onebot.enabled,
    oneBotWsUrl: config.onebot.wsUrl,
    oneBotHttpUrl: config.onebot.httpUrl,
    dataDir: config.dataDir,
    configDir: config.configRuntime.configDir,
    instanceName: config.configRuntime.instanceName ?? null,
    internalApiEnabled: config.internalApi.enabled,
    internalApiPort: config.internalApi.port,
    searchEnabled: enabledSearchProviders.length > 0,
    searchProvider: enabledSearchProviders.length > 0 ? enabledSearchProviders.join(",") : "none",
    browserEnabled: config.browser.enabled,
    whitelistEnabled: config.whitelist.enabled,
    userWhitelistSize: whitelistSummary?.userWhitelistSize ?? 0,
    groupWhitelistSize: whitelistSummary?.groupWhitelistSize ?? 0
  };
}
