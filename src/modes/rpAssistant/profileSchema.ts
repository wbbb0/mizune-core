import { s, type Infer } from "#data/schema/index.ts";

function createProfileFieldSchema(title: string) {
  return s.string().title(title).default("");
}

export const rpProfileSchema = s.object({
  appearance: createProfileFieldSchema("外貌"),
  premise: createProfileFieldSchema("前提"),
  relationship: createProfileFieldSchema("关系"),
  identityBoundary: createProfileFieldSchema("身份边界"),
  styleRules: createProfileFieldSchema("风格规则"),
  hardRules: createProfileFieldSchema("硬规则")
}).title("RP 全局资料")
  .describe("定义面向角色扮演协作的全局资料。")
  .strict();

export type RpProfile = Infer<typeof rpProfileSchema>;

export const editableRpProfileFieldNames = [
  "appearance",
  "premise",
  "relationship",
  "identityBoundary",
  "styleRules",
  "hardRules"
] as const;

export type EditableRpProfileFieldName = typeof editableRpProfileFieldNames[number];

export const rpProfileFieldLabels: Record<EditableRpProfileFieldName, string> = {
  appearance: "外貌",
  premise: "前提",
  relationship: "关系",
  identityBoundary: "身份边界",
  styleRules: "风格规则",
  hardRules: "硬规则"
};

const requiredRpProfileFieldNames = [
  "premise",
  "identityBoundary",
  "hardRules"
] as const satisfies readonly EditableRpProfileFieldName[];

export function createEmptyRpProfile(): RpProfile {
  return {
    appearance: "",
    premise: "",
    relationship: "",
    identityBoundary: "",
    styleRules: "",
    hardRules: ""
  };
}

export function describeMissingRpProfileFields(profile: RpProfile): EditableRpProfileFieldName[] {
  return requiredRpProfileFieldNames.filter((field) => !profile[field].trim());
}

export function getMissingRpProfileFields(profile: RpProfile): EditableRpProfileFieldName[] {
  return describeMissingRpProfileFields(profile);
}

export function isRpProfileComplete(profile: RpProfile): boolean {
  return describeMissingRpProfileFields(profile).length === 0;
}
