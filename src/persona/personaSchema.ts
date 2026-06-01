import { s, type Infer } from "#data/schema/index.ts";

function createPersonaFieldSchema(title: string) {
  return s.string().title(title).default("");
}

export const personaSchema = s.object({
  name: createPersonaFieldSchema("名字"),
  temperament: createPersonaFieldSchema("性格底色"),
  voiceStyle: createPersonaFieldSchema("语气风格"),
}).title("全局人格")
  .describe("定义 bot 在所有模式下共享的人格底色与语气风格。")
  .strict();

export type Persona = Infer<typeof personaSchema>;

export const editablePersonaFieldNames = [
  "name",
  "temperament",
  "voiceStyle"
] as const;

export type EditablePersonaFieldName = typeof editablePersonaFieldNames[number];

export const personaFieldLabels: Record<EditablePersonaFieldName, string> = {
  name: "名字",
  temperament: "性格底色",
  voiceStyle: "语气风格"
};

export function createEmptyPersona(): Persona {
  return {
    name: "",
    temperament: "",
    voiceStyle: ""
  };
}

const requiredPersonaFieldNames = [
  "name",
  "temperament",
  "voiceStyle"
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
