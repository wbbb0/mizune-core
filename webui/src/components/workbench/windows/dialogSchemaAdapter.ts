import type { SchemaMeta } from "../../../../../src/data/schema/types.ts";
import type { WorkbenchDialogField } from "./types.js";

type DialogValues = Record<string, unknown>;
type SupportedField = WorkbenchDialogField<DialogValues>;
type SupportedGroupChild = Exclude<SupportedField, { kind: "group" }>;

export function schemaMetaToDialogFields(meta: SchemaMeta): SupportedField[] {
  if (meta.kind !== "object") {
    throw new Error(`Unsupported schema meta root kind: ${meta.kind}`);
  }

  return Object.entries(meta.fields).map(([key, fieldMeta]) => convertField(key, fieldMeta));
}

function convertField(key: string, meta: SchemaMeta): SupportedField {
  const label = meta.title?.trim() || key;

  switch (meta.kind) {
    case "string":
      return {
        kind: "string",
        key,
        label,
        ...(typeof meta.defaultValue === "string" ? { defaultValue: meta.defaultValue } : {})
      };

    case "number":
      return {
        kind: "number",
        key,
        label,
        ...(typeof meta.defaultValue === "number" ? { defaultValue: meta.defaultValue } : {}),
        ...(typeof meta.min === "number" ? { min: meta.min } : {}),
        ...(typeof meta.max === "number" ? { max: meta.max } : {})
      };

    case "boolean":
      return {
        kind: "boolean",
        key,
        label,
        ...(typeof meta.defaultValue === "boolean" ? { defaultValue: meta.defaultValue } : {})
      };

    case "enum":
      return {
        kind: "enum",
        key,
        label,
        ...(meta.defaultValue != null ? { defaultValue: String(meta.defaultValue) } : {}),
        options: meta.values.map((value) => ({
          label: String(value),
          value: String(value)
        }))
      };

    case "object":
      return {
        kind: "group",
        key,
        label,
        fields: Object.entries(meta.fields).map(([childKey, childMeta]) => convertGroupField(childKey, childMeta))
      };

    default:
      throw new Error(`Unsupported schema meta kind: ${meta.kind}`);
  }
}

function convertGroupField(key: string, meta: SchemaMeta): SupportedGroupChild {
  if (meta.kind === "object") {
    throw new Error(`Unsupported schema meta kind in group: ${meta.kind}`);
  }
  return convertField(key, meta) as SupportedGroupChild;
}
