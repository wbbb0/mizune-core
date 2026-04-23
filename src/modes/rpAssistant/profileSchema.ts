import { s, type Infer } from "#data/schema/index.ts";

function createProfileFieldSchema(title: string) {
  return s.string().title(title).default("");
}

export const rpProfileSchema = s.object({
  selfPositioning: createProfileFieldSchema("自我定位"),
  socialRole: createProfileFieldSchema("社会角色"),
  lifeContext: createProfileFieldSchema("生活状态"),
  physicalPresence: createProfileFieldSchema("外在存在感"),
  bondToUser: createProfileFieldSchema("与用户关系"),
  closenessPattern: createProfileFieldSchema("亲密模式"),
  interactionPattern: createProfileFieldSchema("互动模式"),
  realityContract: createProfileFieldSchema("现实契约"),
  continuityFacts: createProfileFieldSchema("连续性事实"),
  hardLimits: createProfileFieldSchema("硬边界")
}).title("RP 全局资料")
  .describe("定义 rp_assistant 模式下的全局真人化设定、关系基线与现实契约。")
  .strict();

export type RpProfile = Infer<typeof rpProfileSchema>;

export const editableRpProfileFieldNames = [
  "selfPositioning",
  "socialRole",
  "lifeContext",
  "physicalPresence",
  "bondToUser",
  "closenessPattern",
  "interactionPattern",
  "realityContract",
  "continuityFacts",
  "hardLimits"
] as const;

export type EditableRpProfileFieldName = typeof editableRpProfileFieldNames[number];

export const rpProfileFieldLabels: Record<EditableRpProfileFieldName, string> = {
  selfPositioning: "自我定位",
  socialRole: "社会角色",
  lifeContext: "生活状态",
  physicalPresence: "外在存在感",
  bondToUser: "与用户关系",
  closenessPattern: "亲密模式",
  interactionPattern: "互动模式",
  realityContract: "现实契约",
  continuityFacts: "连续性事实",
  hardLimits: "硬边界"
};

const requiredRpProfileFieldNames = [
  "selfPositioning",
  "socialRole",
  "lifeContext",
  "physicalPresence",
  "bondToUser",
  "closenessPattern",
  "interactionPattern",
  "realityContract",
  "hardLimits"
] as const satisfies readonly EditableRpProfileFieldName[];

export function createEmptyRpProfile(): RpProfile {
  return {
    selfPositioning: "",
    socialRole: "",
    lifeContext: "",
    physicalPresence: "",
    bondToUser: "",
    closenessPattern: "",
    interactionPattern: "",
    realityContract: "",
    continuityFacts: "",
    hardLimits: ""
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
