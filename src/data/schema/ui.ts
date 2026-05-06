import { BaseSchema } from "./base.ts";
import type { ObjectFieldMeta, SchemaMeta, UiNode } from "./types.ts";

export function buildUiTree(schema: BaseSchema<any>): UiNode {
  return buildUiTreeFromMeta(schema.toMeta());
}

export function buildUiTreeFromMeta(meta: SchemaMeta): UiNode {
  switch (meta.kind) {
    case "object": {
      const children: Record<string, { field: ObjectFieldMeta; node: UiNode }> = {};
      for (const [key, field] of Object.entries(meta.fields)) {
        children[key] = {
          field,
          node: buildUiTreeFromMeta(field.schema),
        };
      }
      return {
        kind: "group",
        schema: meta,
        children,
      };
    }

    case "array":
      return {
        kind: "array",
        schema: meta,
        item: buildUiTreeFromMeta(meta.item),
      };

    case "record":
      return {
        kind: "record",
        schema: meta,
        key: buildUiTreeFromMeta(meta.key),
        value: buildUiTreeFromMeta(meta.value),
      };

    case "union":
      return {
        kind: "union",
        schema: meta,
        options: meta.options.map((option) => buildUiTreeFromMeta(option)),
      };

    default:
      return {
        kind: "field",
        schema: meta,
      };
  }
}
