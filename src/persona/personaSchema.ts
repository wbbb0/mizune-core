import { s, type Infer } from "#data/schema/index.ts";

const personaFieldSchema = s.string().default("");

export const personaSchema = s.object({
  name: personaFieldSchema,
  identity: personaFieldSchema,
  virtualAppearance: personaFieldSchema,
  personality: personaFieldSchema,
  hobbies: personaFieldSchema,
  likesAndDislikes: personaFieldSchema,
  familyBackground: personaFieldSchema,
  speakingStyle: personaFieldSchema,
  secrets: personaFieldSchema,
  residence: personaFieldSchema,
  roleplayRequirements: personaFieldSchema
}).strict();

export type Persona = Infer<typeof personaSchema>;

export const editablePersonaFieldNames = [
  "name",
  "identity",
  "virtualAppearance",
  "personality",
  "hobbies",
  "likesAndDislikes",
  "familyBackground",
  "speakingStyle",
  "secrets",
  "residence",
  "roleplayRequirements"
] as const;

export type EditablePersonaFieldName = typeof editablePersonaFieldNames[number];

export const personaFieldLabels: Record<EditablePersonaFieldName, string> = {
  name: "名字",
  identity: "身份",
  virtualAppearance: "外貌",
  personality: "性格",
  hobbies: "爱好",
  likesAndDislikes: "喜欢/讨厌",
  familyBackground: "家庭背景",
  speakingStyle: "说话习惯",
  secrets: "秘密",
  residence: "住处",
  roleplayRequirements: "额外角色要求"
};

export function createEmptyPersona(): Persona {
  return {
    name: "",
    identity: "",
    virtualAppearance: "",
    personality: "",
    hobbies: "",
    likesAndDislikes: "",
    familyBackground: "",
    speakingStyle: "",
    secrets: "",
    residence: "",
    roleplayRequirements: ""
  };
}

export function getMissingPersonaFields(persona: Persona): EditablePersonaFieldName[] {
  return editablePersonaFieldNames.filter((field) => !persona[field].trim());
}

export function isPersonaComplete(persona: Persona): boolean {
  return getMissingPersonaFields(persona).length === 0;
}

export function normalizeStoredPersona(raw: unknown): Persona | null {
  try {
    return personaSchema.parse(raw);
  } catch {
    return null;
  }
}
