import { BaseSchema } from "./base.ts";
import type { SchemaMeta, UiNode } from "./types.ts";

export function buildUiTree(schema: BaseSchema<any>): UiNode {
  return buildUiTreeFromMeta(schema.toMeta());
}

export function buildUiTreeFromMeta(meta: SchemaMeta): UiNode {
  switch (meta.kind) {
    case "object": {
      const children: Record<string, UiNode> = {};
      for (const [key, child] of Object.entries(meta.fields)) {
        children[key] = buildUiTreeFromMeta(child);
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
