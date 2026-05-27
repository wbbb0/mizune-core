<script setup lang="ts">
import { computed } from "vue";
import { SchemaNode, type ObjectFieldMeta, type SchemaMeta, type UiNode } from "@workbench-kit/vue";

const props = defineProps<{
  value: unknown;
  node?: UiNode;
}>();

const viewerNode = computed(() => props.node ?? buildUiTreeFromValue(props.value));

function buildUiTreeFromValue(value: unknown): UiNode {
  return buildUiTreeFromMeta(inferSchemaMeta(value));
}

function buildUiTreeFromMeta(meta: SchemaMeta): UiNode {
  switch (meta.kind) {
    case "object": {
      const children: Record<string, { field: ObjectFieldMeta; node: UiNode }> = {};
      for (const [key, field] of Object.entries(meta.fields ?? {})) {
        children[key] = {
          field,
          node: buildUiTreeFromMeta(field.schema)
        };
      }
      return { kind: "group", schema: meta, children };
    }
    case "array":
      return {
        kind: "array",
        schema: meta,
        item: buildUiTreeFromMeta(meta.item ?? jsonMeta())
      };
    case "record":
      return {
        kind: "record",
        schema: meta,
        key: buildUiTreeFromMeta(meta.key ?? stringMeta()),
        value: buildUiTreeFromMeta(meta.recordValue ?? jsonMeta())
      };
    case "union":
      return {
        kind: "union",
        schema: meta,
        options: (meta.options ?? []).map((option) => buildUiTreeFromMeta(option))
      };
    default:
      return { kind: "field", schema: meta };
  }
}

function inferSchemaMeta(value: unknown, depth = 0): SchemaMeta {
  if (depth > 8) return jsonMeta();
  if (typeof value === "string") return stringMeta();
  if (typeof value === "number") return numberMeta(Number.isInteger(value));
  if (typeof value === "boolean") return booleanMeta();
  if (value === null) return literalMeta(null);
  if (Array.isArray(value)) {
    if (value.length === 0) return jsonMeta();
    return {
      ...baseMeta("array"),
      item: inferArrayItemMeta(value, depth + 1)
    };
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) return jsonMeta();
    return objectMetaFromValues([value], depth + 1);
  }
  return jsonMeta();
}

function inferArrayItemMeta(items: unknown[], depth: number): SchemaMeta {
  return inferMetaFromSamples(items.filter((item) => item !== undefined), depth);
}

function objectMetaFromValues(values: Array<Record<string, unknown>>, depth: number): SchemaMeta {
  const keys = [...new Set(values.flatMap((value) => Object.keys(value)))];
  const fields = Object.fromEntries(keys.map((key) => {
    const samples = values.map((value) => value[key]).filter((value) => value !== undefined);
    return [key, { title: key, schema: inferMetaFromSamples(samples, depth) }];
  }));
  return {
    ...baseMeta("object"),
    fields,
    unknownKeys: "passthrough"
  };
}

function inferMetaFromSamples(samples: unknown[], depth: number): SchemaMeta {
  if (samples.length === 0) return jsonMeta();
  const kinds = new Set(samples.map(valueKind));
  if (kinds.size !== 1) return jsonMeta();
  const kind = samples[0] === undefined ? "undefined" : valueKind(samples[0]);
  if (kind === "object") {
    const objectSamples = samples.filter(isPlainObject);
    return objectSamples.length > 0 ? objectMetaFromValues(objectSamples, depth + 1) : jsonMeta();
  }
  if (kind === "array") {
    const arrays = samples.filter(Array.isArray);
    return {
      ...baseMeta("array"),
      item: inferArrayItemMeta(arrays.flat(), depth + 1)
    };
  }
  return inferSchemaMeta(samples[0], depth + 1);
}

function valueKind(value: unknown): "array" | "object" | "string" | "number" | "boolean" | "null" | "undefined" | "other" {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isPlainObject(value)) return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "other";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function baseMeta(kind: string): SchemaMeta {
  return { kind, optional: false, hasDefault: false };
}

function stringMeta(): SchemaMeta {
  return baseMeta("string");
}

function numberMeta(integer: boolean): SchemaMeta {
  return { ...baseMeta("number"), integer };
}

function booleanMeta(): SchemaMeta {
  return baseMeta("boolean");
}

function literalMeta(value: string | number | boolean | null): SchemaMeta {
  return { ...baseMeta("literal"), value };
}

function jsonMeta(): SchemaMeta {
  return baseMeta("json");
}
</script>

<template>
  <div class="scrollbar-thin max-h-96 overflow-auto rounded border border-border-subtle bg-surface-muted/40 px-2 py-1.5">
    <SchemaNode
      :node="viewerNode"
      :model-value="value"
      :stored-value="value"
      :effective-value="value"
      :depth="0"
      read-only
    />
  </div>
</template>
