import { s, type Infer } from "#data/schema/index.ts";

function createProfileFieldSchema(title: string) {
  return s.string().title(title).default("");
}

export const rpProfileSchema = s.object({
  identity: createProfileFieldSchema("身份定位"),
  background: createProfileFieldSchema("稳定背景"),
  continuityFacts: createProfileFieldSchema("连续性事实"),
  boundaries: createProfileFieldSchema("边界")
}).title("RP 全局资料")
  .describe("定义 rp_assistant 模式下 bot 自身的身份、稳定背景与边界。")
  .strict();

export type RpProfile = Infer<typeof rpProfileSchema>;

export const editableRpProfileFieldNames = [
  "identity",
  "background",
  "continuityFacts",
  "boundaries"
] as const;

export type EditableRpProfileFieldName = typeof editableRpProfileFieldNames[number];

export const rpProfileFieldLabels: Record<EditableRpProfileFieldName, string> = {
  identity: "身份定位",
  background: "稳定背景",
  continuityFacts: "连续性事实",
  boundaries: "边界"
};

const requiredRpProfileFieldNames = [
  "identity",
  "background",
  "boundaries"
] as const satisfies readonly EditableRpProfileFieldName[];

export function createEmptyRpProfile(): RpProfile {
  return {
    identity: "",
    background: "",
    continuityFacts: "",
    boundaries: ""
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
