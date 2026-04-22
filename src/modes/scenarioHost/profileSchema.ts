import { s, type Infer } from "#data/schema/index.ts";

function createProfileFieldSchema(title: string) {
  return s.string().title(title).default("");
}

export const scenarioProfileSchema = s.object({
  theme: createProfileFieldSchema("主题"),
  hostStyle: createProfileFieldSchema("主持风格"),
  worldBaseline: createProfileFieldSchema("世界基线"),
  safetyOrTabooRules: createProfileFieldSchema("安全/禁忌规则"),
  openingPattern: createProfileFieldSchema("开场模式")
}).title("场景主持全局资料")
  .describe("定义场景主持模式的全局资料。")
  .strict();

export type ScenarioProfile = Infer<typeof scenarioProfileSchema>;

export const editableScenarioProfileFieldNames = [
  "theme",
  "hostStyle",
  "worldBaseline",
  "safetyOrTabooRules",
  "openingPattern"
] as const;

export type EditableScenarioProfileFieldName = typeof editableScenarioProfileFieldNames[number];

export const scenarioProfileFieldLabels: Record<EditableScenarioProfileFieldName, string> = {
  theme: "主题",
  hostStyle: "主持风格",
  worldBaseline: "世界基线",
  safetyOrTabooRules: "安全/禁忌规则",
  openingPattern: "开场模式"
};

const requiredScenarioProfileFieldNames = [
  "theme",
  "hostStyle",
  "worldBaseline"
] as const satisfies readonly EditableScenarioProfileFieldName[];

export function createEmptyScenarioProfile(): ScenarioProfile {
  return {
    theme: "",
    hostStyle: "",
    worldBaseline: "",
    safetyOrTabooRules: "",
    openingPattern: ""
  };
}

export function describeMissingScenarioProfileFields(profile: ScenarioProfile): EditableScenarioProfileFieldName[] {
  return requiredScenarioProfileFieldNames.filter((field) => !profile[field].trim());
}

export function getMissingScenarioProfileFields(profile: ScenarioProfile): EditableScenarioProfileFieldName[] {
  return describeMissingScenarioProfileFields(profile);
}

export function isScenarioProfileComplete(profile: ScenarioProfile): boolean {
  return describeMissingScenarioProfileFields(profile).length === 0;
}
