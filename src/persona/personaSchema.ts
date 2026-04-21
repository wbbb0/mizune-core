import { s, type Infer } from "#data/schema/index.ts";

function createPersonaFieldSchema(title: string) {
  return s.string().title(title).default("");
}

export const personaSchema = s.object({
  name: createPersonaFieldSchema("名字"),
  role: createPersonaFieldSchema("角色定位"),
  appearance: createPersonaFieldSchema("外貌"),
  personality: createPersonaFieldSchema("性格"),
  interests: createPersonaFieldSchema("兴趣与喜好"),
  background: createPersonaFieldSchema("背景"),
  speechStyle: createPersonaFieldSchema("说话方式"),
  rules: createPersonaFieldSchema("行为规则")
}).title("人设")
  .describe("定义默认角色形象、说话方式和行为约束。")
  .strict();

export type Persona = Infer<typeof personaSchema>;

export const editablePersonaFieldNames = [
  "name",
  "role",
  "appearance",
  "personality",
  "interests",
  "background",
  "speechStyle",
  "rules"
] as const;

export type EditablePersonaFieldName = typeof editablePersonaFieldNames[number];

export const personaFieldLabels: Record<EditablePersonaFieldName, string> = {
  name: "名字",
  role: "角色定位",
  appearance: "外貌",
  personality: "性格",
  interests: "兴趣与喜好",
  background: "背景",
  speechStyle: "说话方式",
  rules: "行为规则"
};

export function createEmptyPersona(): Persona {
  return {
    name: "",
    role: "",
    appearance: "",
    personality: "",
    interests: "",
    background: "",
    speechStyle: "",
    rules: ""
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
