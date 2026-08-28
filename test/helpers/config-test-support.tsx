import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";

export async function withTempDir(name: string, fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function withConfigDir(name: string, fn: (configDir: string) => Promise<void>) {
  await withTempDir(name, fn);
}

export async function writeYaml(filePath: string, value: unknown) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, YAML.stringify(value), "utf8");
}

export async function writeDefaultInstanceYaml(configDir: string, value: Record<string, unknown> = {}) {
  await writeYaml(join(configDir, "instances", "default.yml"), value);
}

export async function writeLlmCatalog(
  configDir: string,
  value: {
    providers?: Record<string, unknown>;
    models?: Record<string, unknown>;
    routingPresets?: Record<string, unknown>;
  } = {}
) {
  const catalog = buildNestedLlmCatalog(value.providers ?? {}, value.models ?? {});
  const routingPresets = buildTargetRoutingPresets(value.routingPresets ?? {}, value.models ?? {});
  await writeYaml(join(configDir, "llm.catalog.yml"), catalog);
  await writeYaml(join(configDir, "llm.routing-presets.yml"), routingPresets);
}

function buildNestedLlmCatalog(
  providers: Record<string, unknown>,
  models: Record<string, unknown>
): Record<string, unknown> {
  const catalog: Record<string, Record<string, unknown>> = {};

  for (const [providerAlias, rawProvider] of Object.entries(providers)) {
    catalog[providerAlias] = {
      ...(isRecord(rawProvider) ? rawProvider : {}),
      models: {}
    };
  }

  for (const [modelAlias, rawModel] of Object.entries(models)) {
    if (!isRecord(rawModel) || typeof rawModel.provider !== "string" || typeof rawModel.model !== "string") {
      throw new Error(`Invalid test model ${modelAlias}: provider and model are required`);
    }
    const providerAlias = rawModel.provider;
    const provider = catalog[providerAlias] ?? { models: {} };
    const providerModels = isRecord(provider.models) ? provider.models : {};
    const { provider: _provider, model: upstreamModel, ...profile } = rawModel;
    providerModels[modelAlias] = {
      ...profile,
      upstreamModel
    };
    provider.models = providerModels;
    catalog[providerAlias] = provider;
  }

  return catalog;
}

function buildTargetRoutingPresets(
  presets: Record<string, unknown>,
  models: Record<string, unknown>
): Record<string, unknown> {
  const modelProviders = new Map<string, string>();
  for (const [modelAlias, rawModel] of Object.entries(models)) {
    if (isRecord(rawModel) && typeof rawModel.provider === "string") {
      modelProviders.set(modelAlias, rawModel.provider);
    }
  }

  const modelFields = new Set([
    "mainSmall",
    "mainLarge",
    "summarizer",
    "textInspector",
    "sessionCaptioner",
    "imageCaptioner",
    "imageInspector",
    "audioTranscription",
    "turnPlanner",
    "embedding"
  ]);
  const result: Record<string, unknown> = {};

  for (const [presetName, rawPreset] of Object.entries(presets)) {
    if (!isRecord(rawPreset)) {
      result[presetName] = rawPreset;
      continue;
    }
    const preset: Record<string, unknown> = {};
    for (const [field, rawValue] of Object.entries(rawPreset)) {
      if (!modelFields.has(field)) {
        preset[field] = rawValue;
        continue;
      }
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      preset[field] = values.map((modelAlias) => {
        if (isRecord(modelAlias)) {
          return modelAlias;
        }
        const alias = String(modelAlias);
        const provider = modelProviders.get(alias);
        if (!provider) {
          throw new Error(`Unknown test model reference ${alias} in preset ${presetName}.${field}`);
        }
        return { provider, model: alias };
      });
    }
    result[presetName] = preset;
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
