import { s, type Infer } from "#data/schema/index.ts";
import {
  createEmptyScenarioProfile,
  isScenarioProfileComplete,
  scenarioProfileSchema
} from "./profileSchema.ts";

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

export const scenarioHostLoreEntrySchema = s.object({
  id: s.string().trim().nonempty(),
  title: s.string().trim().nonempty(),
  content: s.string().default(""),
  tags: s.array(s.string().trim().nonempty()).default([]),
  activationKeys: s.array(s.string().trim().nonempty()).default([]),
  enabled: s.boolean().default(true),
  priority: s.number().int().default(100),
  createdAtTurn: s.number().int().min(0).default(0),
  updatedAtTurn: s.number().int().min(0).default(0)
}).strict();

export const scenarioHostEntitySchema = s.object({
  id: s.string().trim().nonempty(),
  kind: s.enum(["npc", "location", "faction", "item", "organization", "other"]).default("other"),
  name: s.string().trim().nonempty(),
  aliases: s.array(s.string().trim().nonempty()).default([]),
  summary: s.string().default(""),
  status: s.string().default(""),
  locationId: s.union([s.string().trim().nonempty(), s.literal(null)]).default(null),
  tags: s.array(s.string().trim().nonempty()).default([]),
  notes: s.string().default("")
}).strict();

export const scenarioHostRelationSchema = s.object({
  sourceId: s.string().trim().nonempty(),
  targetId: s.string().trim().nonempty(),
  kind: s.string().trim().nonempty(),
  summary: s.string().default(""),
  strength: s.number().min(-100).max(100).default(0),
  updatedAtTurn: s.number().int().min(0).default(0)
}).strict();

export const scenarioHostJournalEntrySchema = s.object({
  id: s.string().trim().nonempty(),
  turnIndex: s.number().int().min(0).default(0),
  title: s.string().trim().nonempty(),
  summary: s.string().default(""),
  entityIds: s.array(s.string().trim().nonempty()).default([]),
  tags: s.array(s.string().trim().nonempty()).default([]),
  createdAtMs: s.number().int().min(0).default(0)
}).strict();

export const scenarioHostMechanicsSchema = s.object({
  ruleStyle: s.enum(["freeform", "light_checks", "dice"]).default("freeform"),
  dicePolicy: s.string().default(""),
  difficultyScale: s.string().default(""),
  successStates: s.array(s.string().trim().nonempty()).default([])
}).strict();

export const scenarioHostSessionStateSchema = s.object({
  version: s.literal(3),
  profile: scenarioProfileSchema.default(createEmptyScenarioProfile),
  currentSituation: s.string().default("场景尚未开始。"),
  currentLocation: s.union([s.string(), s.literal(null)]).default(null),
  sceneSummary: s.string().default(""),
  player: scenarioHostPlayerSchema,
  inventory: s.array(scenarioHostInventoryItemSchema).default([]),
  objectives: s.array(scenarioHostObjectiveSchema).default([]),
  loreEntries: s.array(scenarioHostLoreEntrySchema).default([]),
  entities: s.array(scenarioHostEntitySchema).default([]),
  relations: s.array(scenarioHostRelationSchema).default([]),
  journal: s.array(scenarioHostJournalEntrySchema).default([]),
  mechanics: scenarioHostMechanicsSchema.default({
    ruleStyle: "freeform",
    dicePolicy: "",
    difficultyScale: "",
    successStates: []
  }),
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
export type ScenarioHostLoreEntry = Infer<typeof scenarioHostLoreEntrySchema>;
export type ScenarioHostEntity = Infer<typeof scenarioHostEntitySchema>;
export type ScenarioHostRelation = Infer<typeof scenarioHostRelationSchema>;
export type ScenarioHostJournalEntry = Infer<typeof scenarioHostJournalEntrySchema>;
export type ScenarioHostMechanics = Infer<typeof scenarioHostMechanicsSchema>;
export type ScenarioHostSessionState = Infer<typeof scenarioHostSessionStateSchema>;

type LegacyScenarioHostSessionStateV1 = {
  version: 1;
  currentSituation?: string;
  currentLocation?: string | null;
  sceneSummary?: string;
  player?: ScenarioHostPlayer;
  inventory?: ScenarioHostInventoryItem[];
  objectives?: ScenarioHostObjective[];
  worldFacts?: string[];
  flags?: Record<string, string | number | boolean>;
  initialized?: boolean;
  turnIndex?: number;
};

type LegacyScenarioHostSessionStateV2 = Omit<LegacyScenarioHostSessionStateV1, "version"> & {
  version: 2;
  profile?: unknown;
};

export function createInitialScenarioHostSessionState(input: {
  playerUserId: string;
  playerDisplayName: string;
}): ScenarioHostSessionState {
  return scenarioHostSessionStateSchema.parse({
    version: 3,
    profile: createEmptyScenarioProfile(),
    currentSituation: "场景尚未开始，请根据玩家接下来的行动开始主持。",
    currentLocation: null,
    sceneSummary: "",
    player: {
      userId: input.playerUserId,
      displayName: input.playerDisplayName
    },
    inventory: [],
    objectives: [],
    loreEntries: [],
    entities: [],
    relations: [],
    journal: [],
    mechanics: {},
    flags: {},
    initialized: false,
    turnIndex: 0
  });
}

export function isScenarioStateInitialized(state: ScenarioHostSessionState): boolean {
  return state.initialized;
}

export function isScenarioSessionProfileComplete(state: ScenarioHostSessionState): boolean {
  return isScenarioProfileComplete(state.profile);
}

export function migrateScenarioHostSessionState(value: unknown): ScenarioHostSessionState {
  const raw = value as { version?: unknown; profile?: unknown };
  if (raw?.version === 3) {
    return scenarioHostSessionStateSchema.parse(raw);
  }
  if (raw?.version === 2) {
    const legacy = raw as LegacyScenarioHostSessionStateV2;
    const { worldFacts = [], ...state } = legacy;
    return scenarioHostSessionStateSchema.parse({
      ...state,
      version: 3,
      profile: legacy.profile ?? createEmptyScenarioProfile(),
      loreEntries: legacyWorldFactsToLoreEntries(worldFacts, legacy.turnIndex ?? 0),
      entities: [],
      relations: [],
      journal: [],
      mechanics: {}
    });
  }
  if (raw?.version === 1) {
    const legacy = raw as LegacyScenarioHostSessionStateV1;
    const { worldFacts = [], ...state } = legacy;
    return scenarioHostSessionStateSchema.parse({
      ...state,
      version: 3,
      profile: createEmptyScenarioProfile(),
      loreEntries: legacyWorldFactsToLoreEntries(worldFacts, legacy.turnIndex ?? 0),
      entities: [],
      relations: [],
      journal: [],
      mechanics: {}
    });
  }
  return scenarioHostSessionStateSchema.parse(raw);
}

function legacyWorldFactsToLoreEntries(worldFacts: string[], turnIndex: number): ScenarioHostLoreEntry[] {
  const entries: ScenarioHostLoreEntry[] = [];
  worldFacts.forEach((fact, index) => {
    const content = fact.trim();
    if (!content) {
      return;
    }
    entries.push({
      id: `legacy-fact-${index + 1}`,
      title: `世界事实 ${index + 1}`,
      content,
      tags: [],
      activationKeys: [],
      enabled: true,
      priority: 100,
      createdAtTurn: Math.max(0, turnIndex),
      updatedAtTurn: Math.max(0, turnIndex)
    });
  });
  return entries;
}
