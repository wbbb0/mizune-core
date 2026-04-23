import { s, type Infer } from "#data/schema/index.ts";

function createPersonaFieldSchema(title: string) {
  return s.string().title(title).default("");
}

export const personaSchema = s.object({
  name: createPersonaFieldSchema("名字"),
  temperament: createPersonaFieldSchema("性格底色"),
  speakingStyle: createPersonaFieldSchema("说话方式"),
  globalTraits: createPersonaFieldSchema("全局特征"),
  generalPreferences: createPersonaFieldSchema("通用偏好"),
}).title("全局人格")
  .describe("定义 bot 在所有模式下共享的人格底色、说话方式与全局偏好。")
  .strict();

export type Persona = Infer<typeof personaSchema>;

export const editablePersonaFieldNames = [
  "name",
  "temperament",
  "speakingStyle",
  "globalTraits",
  "generalPreferences"
] as const;

export type EditablePersonaFieldName = typeof editablePersonaFieldNames[number];

export const personaFieldLabels: Record<EditablePersonaFieldName, string> = {
  name: "名字",
  temperament: "性格底色",
  speakingStyle: "说话方式",
  globalTraits: "全局特征",
  generalPreferences: "通用偏好"
};

export function createEmptyPersona(): Persona {
  return {
    name: "",
    temperament: "",
    speakingStyle: "",
    globalTraits: "",
    generalPreferences: ""
  };
}

const requiredPersonaFieldNames = [
  "name",
  "temperament",
  "speakingStyle"
] as const satisfies readonly EditablePersonaFieldName[];

export function describeMissingPersonaFields(persona: Persona): EditablePersonaFieldName[] {
  return requiredPersonaFieldNames.filter((field) => !persona[field].trim());
}

export function getMissingPersonaFields(persona: Persona): EditablePersonaFieldName[] {
  return describeMissingPersonaFields(persona);
}

export function isPersonaComplete(persona: Persona): boolean {
  return describeMissingPersonaFields(persona).length === 0;
}

export function normalizeStoredPersona(raw: unknown): Persona | null {
  try {
    return personaSchema.parse(raw);
  } catch {
    return null;
  }
}
