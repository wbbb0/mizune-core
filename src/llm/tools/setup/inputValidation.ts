import { Ajv2020 } from "ajv/dist/2020.js";
import type { JsonObject } from "../../../character/schemaCatalog.ts";
const ajv = new Ajv2020({ strict: false, allErrors: true });
const cache = new WeakMap<object, ReturnType<typeof ajv.compile>>();

/** 初始化输入禁止把 JSON 对象/数组包进任何字符串；只检测，不转换。 */
export function jsonStringErrors(value: unknown, path = ""): Array<{ path: string; rule: string; message: string }> {
  if (typeof value === "string") {
    let text = value.trim();
    const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    if (fenced) text = fenced[1]!.trim();
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") return [{ path: path || "/", rule: "json_in_string",
        message: "字符串中不能填写整段 JSON 对象或数组。文本字段只填文本（如名称填小满）；对象或数组字段直接传结构化值，不要加外层引号或代码块。此次未保存。" }];
    } catch { /* 普通文本及含有 JSON 示例的叙述允许保留。 */ }
    return [];
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => jsonStringErrors(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`)).slice(0, 8);
  }
  return [];
}
export function setupInputErrors(schema: JsonObject, value: unknown) {
  const stringErrors = jsonStringErrors(value);
  if (stringErrors.length) return stringErrors;
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
