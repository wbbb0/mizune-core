import { s, type Infer } from "#data/schema/index.ts";

function createProfileFieldSchema(title: string) {
  return s.string().title(title).default("");
}

export const scenarioProfileSchema = s.object({
  theme: createProfileFieldSchema("主题"),
  worldBaseline: createProfileFieldSchema("世界基线"),
  narrationStyle: createProfileFieldSchema("叙事风格"),
  boundaries: createProfileFieldSchema("边界")
}).title("场景主持会话资料")
  .describe("定义当前 Scenario 会话的主题、世界基线与主持风格。")
  .strict();

export type ScenarioProfile = Infer<typeof scenarioProfileSchema>;

export const editableScenarioProfileFieldNames = [
  "theme",
  "worldBaseline",
  "narrationStyle",
  "boundaries"
] as const;

export type EditableScenarioProfileFieldName = typeof editableScenarioProfileFieldNames[number];

export const scenarioProfileFieldLabels: Record<EditableScenarioProfileFieldName, string> = {
  theme: "主题",
  worldBaseline: "世界基线",
  narrationStyle: "叙事风格",
  boundaries: "边界"
};

const requiredScenarioProfileFieldNames = [
  "theme",
  "worldBaseline",
  "narrationStyle"
] as const satisfies readonly EditableScenarioProfileFieldName[];

export function createEmptyScenarioProfile(): ScenarioProfile {
  return {
    theme: "",
    worldBaseline: "",
    narrationStyle: "",
    boundaries: ""
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
