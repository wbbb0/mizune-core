import type { SchemaMeta } from "./types.ts";

/** 将已展开 $ref 的 JSON Schema 转为 workbench 编辑元数据；校验仍以原 Schema 为准。 */
export function jsonSchemaToMeta(schema: Record<string, any>, optional = false): SchemaMeta {
  const base = {
    ...(schema.title ? { title: schema.title } : {}),
    ...(schema.description ? { description: schema.description } : {}),
    optional,
    hasDefault: true,
    defaultValue: initialJsonValue(schema)
  };
  if (Array.isArray(schema.type)) {
    return { ...base, kind: "union", options: schema.type.map((type: string) => {
      const { default: _default, ...branch } = schema;
      return jsonSchemaToMeta({ ...branch, type }, optional);
    }) };
  }
  if (schema.type === "null") return { ...base, kind: "literal", value: null };
  if (schema.enum) return { ...base, kind: "enum", values: schema.enum.filter((value: unknown) => value !== null) };
  switch (schema.type) {
    case "null": return { ...base, kind: "literal", value: null };
    case "string": return { ...base, kind: "string" };
    case "boolean": return { ...base, kind: "boolean" };
    case "integer":
    case "number": return { ...base, kind: "number", integer: schema.type === "integer", min: schema.minimum, max: schema.maximum };
    case "array": return { ...base, kind: "array", item: jsonSchemaToMeta(schema.items) };
    case "object": {
      if (!schema.properties && typeof schema.additionalProperties === "object") {
        return { ...base, kind: "record", key: { kind: "string", optional: false, hasDefault: false }, value: jsonSchemaToMeta(schema.additionalProperties) };
      }
      return {
        ...base, kind: "object", unknownKeys: "strict",
        fields: Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => {
          const child = value as Record<string, any>;
          return [key, { title: child.title, description: child.description, schema: jsonSchemaToMeta(child, !schema.required?.includes(key)) }];
        }))
      };
    }
    default: throw new Error(`不支持的 JSON Schema 类型：${String(schema.type)}`);
  }
}

/** 初次启用可空对象或新增集合条目时，构造完整必填空结构。 */
function initialJsonValue(schema: Record<string, any>): unknown {
  if (Object.hasOwn(schema, "default")) return structuredClone(schema.default);
  if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) return null;
  if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key, initialJsonValue(child as Record<string, any>)]));
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return schema.minimum ?? 0;
  return schema.enum?.find((value: unknown) => value !== null) ?? "";
}
