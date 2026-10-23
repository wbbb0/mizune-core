import { Ajv2020 } from "ajv/dist/2020.js";
import personaDocument from "./schemas/tier1-persona.schema.json" with { type: "json" };
import socialDocument from "./schemas/tier2-social.schema.json" with { type: "json" };
import embodimentDocument from "./schemas/tier3-embodiment-and-simulation.schema.json" with { type: "json" };

export type JsonObject = Record<string, any>;
export type CharacterTier = 1 | 2 | 3;
export interface CharacterSection {
  id: string;
  tier: CharacterTier;
  scope: "character" | "session";
  path: string[];
  description: string;
  schema: JsonObject;
  collectionKey?: string;
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new WeakMap<JsonObject, ReturnType<typeof ajv.compile>>();

function expand(schema: JsonObject, document: JsonObject): JsonObject {
  if (schema.$ref) {
    const resolved = schema.$ref.slice(2).split("/").reduce((value: JsonObject, key: string) => value[key], document);
    const { $ref: _ref, ...annotations } = schema;
    return expand({ ...resolved, ...annotations }, document);
  }
  const result: JsonObject = structuredClone(schema);
  if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) => [key, expand(value as JsonObject, document)]));
  if (result.items) result.items = expand(result.items, document);
  if (typeof result.additionalProperties === "object") result.additionalProperties = expand(result.additionalProperties, document);
  return result;
}

export const personaJsonSchema = expand(personaDocument.properties.character.properties.persona, personaDocument);
export const socialJsonSchema = expand(socialDocument.properties.character.properties.social, socialDocument);
export const embodimentJsonSchema = expand(embodimentDocument.properties.character.properties.embodiment, embodimentDocument);
export const socialStateJsonSchema = expand(socialDocument.properties.sessionState.properties.social, socialDocument);
export const simulationJsonSchema = expand(embodimentDocument.properties.sessionState.properties.simulation, embodimentDocument);

function sectionsFor(tier: CharacterTier, scope: "character" | "session", root: string, schema: JsonObject): CharacterSection[] {
  const result: CharacterSection[] = [];
  const add = (path: string[], part: JsonObject) => {
    const keys = Object.keys(part.properties ?? {});
    // 小对象按块填写；复杂嵌套继续拆分。数组按条目 ID 编辑。
    if (part.type === "object" && keys.length && (keys.some(key => part.properties[key].properties || part.properties[key].$ref) || (root === "persona") || path.at(-1) === "wardrobe")) {
      for (const key of keys) add([...path, key], part.properties[key]);
      return;
    }
    if (path.at(-1) === "initialized") return;
    const collectionKey = part.type === "array" && part.items?.properties
      ? ["id", "instanceId", "participantId"].find(key => key in part.items.properties)
      : undefined;
    result.push({
      id: `${scope === "session" ? "session." : ""}${path.join(".")}`,
      tier, scope, path, schema: part, description: part.description ?? path.join("."),
      ...(collectionKey ? { collectionKey } : {})
    });
  };
  for (const [key, part] of Object.entries(schema.properties ?? {})) add([root, key], part as JsonObject);
  return result;
}

export const characterSections: CharacterSection[] = [
  ...sectionsFor(1, "character", "persona", personaJsonSchema),
  ...sectionsFor(2, "character", "social", socialJsonSchema),
  ...sectionsFor(3, "character", "embodiment", embodimentJsonSchema),
  ...sectionsFor(2, "session", "social", socialStateJsonSchema),
  ...sectionsFor(3, "session", "simulation", simulationJsonSchema)
];

export function getCharacterSection(id: string): CharacterSection {
  const section = characterSections.find(item => item.id === id);
  if (!section) throw new Error(`未知分块 ID：${id}`);
  return section;
}

export function validateJson(schema: JsonObject, value: unknown, id: string): void {
  let validate = validators.get(schema);
  if (!validate) { validate = ajv.compile(schema); validators.set(schema, validate); }
  if (!validate(value)) {
    const details = (validate.errors ?? []).slice(0, 8).map(error => `${error.instancePath || "/"}: ${error.message}`).join("；");
    throw new Error(`分块 ${id} 格式不正确：${details}`);
  }
}

export function emptyValue(schema: JsonObject): any {
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key, emptyValue(child as JsonObject)]));
  if (schema.type === "array") return [];
  if (Array.isArray(schema.type) && schema.type.includes("null")) return null;
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return schema.minimum ?? 0;
  return schema.enum?.[0] ?? "";
}

export function readPath(root: JsonObject, path: string[]): any {
  return path.reduce((value, key) => value?.[key], root);
}
export function setPath(root: JsonObject, path: string[], value: unknown): void {
  if (!path.length || path.some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("无效字段路径");
  let target = root;
  for (const key of path.slice(0, -1)) target = target[key] ??= {};
  target[path.at(-1)!] = structuredClone(value);
}

export function tierForMode(modeId: string): CharacterTier {
  return modeId === "stateful_rp" ? 3 : modeId === "rp_assistant" ? 2 : 1;
}
