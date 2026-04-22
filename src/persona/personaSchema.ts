import { s, type Infer } from "#data/schema/index.ts";

function createPersonaFieldSchema(title: string) {
  return s.string().title(title).default("");
}

export const personaSchema = s.object({
  name: createPersonaFieldSchema("名字"),
  coreIdentity: createPersonaFieldSchema("基础身份"),
  personality: createPersonaFieldSchema("性格"),
  interests: createPersonaFieldSchema("兴趣与喜好"),
  background: createPersonaFieldSchema("背景"),
  speechStyle: createPersonaFieldSchema("说话方式"),
}).title("全局人格")
  .describe("定义 bot 的全局人格、基础身份、性格与说话方式。")
  .strict();

export type Persona = Infer<typeof personaSchema>;

export const editablePersonaFieldNames = [
  "name",
  "coreIdentity",
  "personality",
  "interests",
  "background",
  "speechStyle"
] as const;

export type EditablePersonaFieldName = typeof editablePersonaFieldNames[number];

export const personaFieldLabels: Record<EditablePersonaFieldName, string> = {
  name: "名字",
  coreIdentity: "基础身份",
  personality: "性格",
  interests: "兴趣与喜好",
  background: "背景",
  speechStyle: "说话方式"
};

export function createEmptyPersona(): Persona {
  return {
    name: "",
    coreIdentity: "",
    personality: "",
    interests: "",
    background: "",
    speechStyle: ""
  };
}

const requiredPersonaFieldNames = [
  "name",
  "coreIdentity",
  "personality",
  "speechStyle"
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
