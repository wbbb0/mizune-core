import { Ajv2020 } from "ajv/dist/2020.js";
import type { JsonObject } from "../../../character/schemaCatalog.ts";
const ajv = new Ajv2020({ strict: false, allErrors: true });
const cache = new WeakMap<object, ReturnType<typeof ajv.compile>>();

/** 只解开 Schema 明确声明的对象/数组的一层 JSON；文本字段保持原文。 */
export function normalizeSetupContainers(value: unknown, schema: JsonObject): unknown {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  let next = value;
  if (typeof next === "string" && !types.includes("string") && (types.includes("object") || types.includes("array"))) {
    try { next = JSON.parse(next); } catch { return next; }
  }
  if (Array.isArray(next) && types.includes("array") && schema.items) return next.map(item => normalizeSetupContainers(item, schema.items));
  if (next && typeof next === "object" && !Array.isArray(next) && types.includes("object")) {
    return Object.fromEntries(Object.entries(next).map(([name, item]) => [name, schema.properties?.[name] ? normalizeSetupContainers(item, schema.properties[name]) : item]));
  }
  return next;
}
export function setupInputErrors(schema: JsonObject, value: unknown) {
  let validate = cache.get(schema);
  if (!validate) { validate = ajv.compile(schema); cache.set(schema, validate); }
  if (validate(value)) return [];
  return (validate.errors ?? []).slice(0, 8).map(error => ({
    path: error.instancePath || "/", rule: error.keyword,
    message: error.keyword === "required" ? `缺少字段 ${error.params.missingProperty}`
      : error.keyword === "additionalProperties" ? `不支持字段 ${error.params.additionalProperty}`
      : error.keyword === "type" ? `应提供 ${error.params.type} 类型的值`
      : error.keyword === "enum" ? `允许值：${JSON.stringify(error.params.allowedValues)}`
      : `未满足 ${error.keyword} 约束`,
    constraint: error.params
  }));
}
export function setupInputFailure(errors: unknown, schema: JsonObject) {
  return JSON.stringify({ error: "初始化参数不符合当前工具格式", code: "setup_input_invalid", saved: false, issues: errors,
    nextStep: "根据 issues 修正对应字段后重试，不要原样重复。对象或数组直接传值；普通文本不要编码。", expectedSchema: schema });
}
