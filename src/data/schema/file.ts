import fs from "node:fs/promises";
import YAML from "yaml";
import { BaseSchema } from "./base.ts";
import { cloneDefault, deepMergeAllReplaceArrays, detectFormatFromFilename, isPlainObject } from "./helpers.ts";
import type { ConfigFormat, Infer } from "./types.ts";

export async function readStructuredFileRaw(filePath: string): Promise<unknown> {
  const format = detectFormatFromFilename(filePath);
  const content = await fs.readFile(filePath, "utf8");

  return format === "json"
    ? JSON.parse(content)
    : (YAML.parse(content) as unknown);
}

export async function readConfigFileRaw(filePath: string): Promise<Record<string, unknown>> {
  const parsed = await readStructuredFileRaw(filePath);
  if (parsed == null) {
    return {};
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Root of config must be an object: ${filePath}`);
  }
  return parsed;
}

export type DumpOptions = {
  format: ConfigFormat;
  prettyJsonSpaces?: number;
};

export function dumpConfigString(obj: unknown, options: DumpOptions): string {
  if (options.format === "json") {
    return `${JSON.stringify(obj, null, options.prettyJsonSpaces ?? 2)}\n`;
  }

  return YAML.stringify(obj, {
    indent: 2,
  });
}

export async function writeConfigFile(
  filePath: string,
  obj: unknown,
  options?: Partial<DumpOptions>,
): Promise<void> {
  const format = options?.format ?? detectFormatFromFilename(filePath);
  const content = dumpConfigString(obj, {
    format,
    prettyJsonSpaces: options?.prettyJsonSpaces ?? 2,
  });
  await fs.writeFile(filePath, content, "utf8");
}

export type ParseConfigOptions = {
  cloneInput?: boolean;
};

export function parseConfig<TSchema extends BaseSchema<any>>(
  schema: TSchema,
  input: unknown,
  options?: ParseConfigOptions,
): Infer<TSchema> {
  const finalInput = options?.cloneInput ? cloneDefault(input) : input;
  return schema.parseFromObject(finalInput);
}

export type LoadLayer =
  | string
  | {
    file: string;
    optional?: boolean;
  };

export type LoadConfigOptions<TSchema extends BaseSchema<any>> = {
  schema: TSchema;
  layers: readonly LoadLayer[];
};

export async function loadConfig<TSchema extends BaseSchema<any>>(
  options: LoadConfigOptions<TSchema>,
): Promise<Infer<TSchema>> {
  const rawLayers: Record<string, unknown>[] = [];

  for (const layer of options.layers) {
    const file = typeof layer === "string" ? layer : layer.file;
    const optional = typeof layer === "string" ? false : (layer.optional ?? false);

    try {
      const raw = await readConfigFileRaw(file);
      rawLayers.push(raw);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (optional && nodeError?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  const merged = deepMergeAllReplaceArrays(rawLayers);
  return parseConfig(options.schema, merged);
}

export async function loadAndDumpConfig<TSchema extends BaseSchema<any>>(
  options: LoadConfigOptions<TSchema> & {
    outputPath: string;
    outputFormat?: ConfigFormat;
    prettyJsonSpaces?: number;
  },
): Promise<Infer<TSchema>> {
  const parsed = await loadConfig(options);
  await writeConfigFile(options.outputPath, parsed, {
    ...(options.outputFormat ? { format: options.outputFormat } : {}),
    ...(options.prettyJsonSpaces !== undefined
      ? { prettyJsonSpaces: options.prettyJsonSpaces }
      : {}),
  });
  return parsed;
}
