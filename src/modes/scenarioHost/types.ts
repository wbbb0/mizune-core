import { s, type Infer } from "#data/schema/index.ts";

export const scenarioHostObjectiveSchema = s.object({
  id: s.string().trim().nonempty(),
  title: s.string().trim().nonempty(),
  status: s.enum(["active", "completed", "failed"]).default("active"),
  summary: s.string().default("")
}).strict();

export const scenarioHostInventoryItemSchema = s.object({
  ownerId: s.string().trim().nonempty(),
  item: s.string().trim().nonempty(),
  quantity: s.number().int().min(1).default(1)
}).strict();

export const scenarioHostPlayerSchema = s.object({
  userId: s.string().trim().nonempty(),
  displayName: s.string().trim().nonempty()
}).strict();

export const scenarioHostSessionStateSchema = s.object({
  version: s.literal(1),
  currentSituation: s.string().default("场景尚未开始。"),
  currentLocation: s.union([s.string(), s.literal(null)]).default(null),
  sceneSummary: s.string().default(""),
  player: scenarioHostPlayerSchema,
  inventory: s.array(scenarioHostInventoryItemSchema).default([]),
  objectives: s.array(scenarioHostObjectiveSchema).default([]),
  worldFacts: s.array(s.string()).default([]),
  flags: s.record(
    s.string().trim().nonempty(),
    s.union([s.string(), s.number(), s.boolean()])
  ).default({}),
  initialized: s.boolean().default(false),
  turnIndex: s.number().int().min(0).default(0)
}).strict();

export type ScenarioHostObjective = Infer<typeof scenarioHostObjectiveSchema>;
export type ScenarioHostInventoryItem = Infer<typeof scenarioHostInventoryItemSchema>;
export type ScenarioHostPlayer = Infer<typeof scenarioHostPlayerSchema>;
export type ScenarioHostSessionState = Infer<typeof scenarioHostSessionStateSchema>;

export function createInitialScenarioHostSessionState(input: {
  playerUserId: string;
  playerDisplayName: string;
}): ScenarioHostSessionState {
  return scenarioHostSessionStateSchema.parse({
    version: 1,
    currentSituation: "场景尚未开始，请根据玩家接下来的行动开始主持。",
    currentLocation: null,
    sceneSummary: "",
    player: {
      userId: input.playerUserId,
      displayName: input.playerDisplayName
    },
    inventory: [],
    objectives: [],
    worldFacts: [],
    flags: {},
    initialized: false,
    turnIndex: 0
  });
}

export function isScenarioStateInitialized(state: ScenarioHostSessionState): boolean {
  return state.initialized;
}
