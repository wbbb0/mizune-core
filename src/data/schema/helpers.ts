import path from "node:path";
import { ConfigParseError, type ConfigFormat, type ParseContext } from "./types.ts";

function pathToString(pathSegments: string[]): string {
  return pathSegments.join(".");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneDefault<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function makeIssue(ctx: ParseContext, message: string): ConfigParseError {
  return new ConfigParseError([
    {
      path: pathToString(ctx.path),
      message,
    },
  ]);
}

export function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

export function detectFormatFromFilename(filePath: string): ConfigFormat {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    return "json";
  }
  if (ext === ".yml" || ext === ".yaml") {
    return "yaml";
  }
  throw new Error(`Unsupported config file extension: ${filePath}`);
}

export function deepMergeReplaceArrays<T>(base: T, override: unknown): T {
  if (override === undefined) {
    return base;
  }

  if (Array.isArray(override)) {
    return cloneDefault(override) as T;
  }

  if (!isPlainObject(base) || !isPlainObject(override)) {
    return cloneDefault(override) as T;
  }

  const result: Record<string, unknown> = { ...base };

  for (const [key, overrideValue] of Object.entries(override)) {
    if (overrideValue === undefined) {
      continue;
    }

    const baseValue = result[key];

    if (Array.isArray(overrideValue)) {
      result[key] = cloneDefault(overrideValue);
      continue;
    }

    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMergeReplaceArrays(baseValue, overrideValue);
      continue;
    }

    result[key] = cloneDefault(overrideValue);
  }

  return result as T;
}

export function deepMergeAllReplaceArrays(
  layers: readonly Record<string, unknown>[],
): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    merged = deepMergeReplaceArrays(merged, layer);
  }
  return merged;
}