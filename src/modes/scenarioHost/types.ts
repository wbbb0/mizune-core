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

const legacyScenarioHostInventoryItemSchema = s.object({
  ownerId: s.string().trim().nonempty(),
  item: s.string().trim().nonempty(),
  quantity: s.number().int().min(1).default(1)
}).strict();

export const scenarioHostWornItemSchema = s.object({
  name: s.string().trim().nonempty(),
  wearPosition: s.string().trim().nonempty(),
  description: s.string().trim().nonempty()
}).strict();

export const scenarioHostHeldItemSchema = s.object({
  name: s.string().trim().nonempty(),
  description: s.string().trim().nonempty(),
  quantity: s.number().int().min(1).default(1)
}).strict();

export const scenarioHostPlayerSchema = s.object({
  userId: s.string().trim().nonempty(),
  displayName: s.string().trim().nonempty(),
  basicInfo: s.string().default(""),
  characterDescription: s.string().default(""),
  wornItems: s.array(scenarioHostWornItemSchema).default([]),
  heldItems: s.array(scenarioHostHeldItemSchema).default([]),
  statusDescription: s.string().default("")
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
  kind: s.enum(["location", "faction", "item", "organization", "other"]).default("other"),
  name: s.string().trim().nonempty(),
  aliases: s.array(s.string().trim().nonempty()).default([]),
  summary: s.string().default(""),
  status: s.string().default(""),
  locationId: s.union([s.string().trim().nonempty(), s.literal(null)]).default(null),
  tags: s.array(s.string().trim().nonempty()).default([]),
  notes: s.string().default("")
}).strict();

export const scenarioHostNpcSchema = s.object({
  id: s.string().trim().nonempty(),
  name: s.string().trim().nonempty(),
  aliases: s.array(s.string().trim().nonempty()).default([]),
  basicInfo: s.string().trim().nonempty(),
  characterDescription: s.string().trim().nonempty(),
  wornItems: s.array(scenarioHostWornItemSchema).min(1),
  heldItems: s.array(scenarioHostHeldItemSchema).min(1),
  statusDescription: s.string().default(""),
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

export const scenarioSetupOptionalItemKeys = [
  "boundaries",
  "openingSituation",
  "currentLocation",
  "sceneSummary",
  "initialNpcs",
  "initialObjectives",
  "loreEntries",
  "entities",
  "relations",
  "mechanics"
] as const;

export type ScenarioSetupOptionalItemKey = typeof scenarioSetupOptionalItemKeys[number];

export const scenarioSetupOptionalItemKeySchema = s.enum([...scenarioSetupOptionalItemKeys]);

export const scenarioHostSetupProgressSchema = s.object({
  skippedOptionalItems: s.array(scenarioSetupOptionalItemKeySchema).default([])
}).strict();

export const defaultScenarioCurrentSituation = "场景尚未开始，请根据玩家接下来的行动开始主持。";

export const scenarioHostSessionStateSchema = s.object({
  version: s.literal(5),
  profile: scenarioProfileSchema.default(createEmptyScenarioProfile),
  currentSituation: s.string().default(defaultScenarioCurrentSituation),
  currentLocation: s.union([s.string(), s.literal(null)]).default(null),
  sceneSummary: s.string().default(""),
  player: scenarioHostPlayerSchema,
  objectives: s.array(scenarioHostObjectiveSchema).default([]),
  loreEntries: s.array(scenarioHostLoreEntrySchema).default([]),
  npcs: s.array(scenarioHostNpcSchema).default([]),
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
  setupProgress: scenarioHostSetupProgressSchema.default({
    skippedOptionalItems: []
  }),
  initialized: s.boolean().default(false),
  turnIndex: s.number().int().min(0).default(0)
}).strict();

export type ScenarioHostObjective = Infer<typeof scenarioHostObjectiveSchema>;
type LegacyScenarioHostInventoryItem = Infer<typeof legacyScenarioHostInventoryItemSchema>;
export type ScenarioHostWornItem = Infer<typeof scenarioHostWornItemSchema>;
export type ScenarioHostHeldItem = Infer<typeof scenarioHostHeldItemSchema>;
export type ScenarioHostPlayer = Infer<typeof scenarioHostPlayerSchema>;
export type ScenarioHostLoreEntry = Infer<typeof scenarioHostLoreEntrySchema>;
export type ScenarioHostEntity = Infer<typeof scenarioHostEntitySchema>;
export type ScenarioHostNpc = Infer<typeof scenarioHostNpcSchema>;
export type ScenarioHostRelation = Infer<typeof scenarioHostRelationSchema>;
export type ScenarioHostJournalEntry = Infer<typeof scenarioHostJournalEntrySchema>;
export type ScenarioHostMechanics = Infer<typeof scenarioHostMechanicsSchema>;
export type ScenarioHostSetupProgress = Infer<typeof scenarioHostSetupProgressSchema>;
export type ScenarioHostSessionState = Infer<typeof scenarioHostSessionStateSchema>;

type LegacyScenarioHostSessionStateV1 = {
  version: 1;
  currentSituation?: string;
  currentLocation?: string | null;
  sceneSummary?: string;
  player?: ScenarioHostPlayer;
  inventory?: LegacyScenarioHostInventoryItem[];
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

type LegacyScenarioHostEntityV3 = {
  id: string;
  kind?: "npc" | "location" | "faction" | "item" | "organization" | "other";
  name: string;
  aliases?: string[];
  summary?: string;
  status?: string;
  locationId?: string | null;
  tags?: string[];
  notes?: string;
};

type LegacyScenarioHostSessionStateV3 = Omit<LegacyScenarioHostSessionStateV2, "version"> & {
  version: 3;
  loreEntries?: ScenarioHostLoreEntry[];
  entities?: LegacyScenarioHostEntityV3[];
  relations?: ScenarioHostRelation[];
  journal?: ScenarioHostJournalEntry[];
  mechanics?: Partial<ScenarioHostMechanics>;
};

type LegacyScenarioHostSessionStateV4 = Omit<ScenarioHostSessionState, "version"> & {
  version: 4;
  inventory?: LegacyScenarioHostInventoryItem[];
};

export function createInitialScenarioHostSessionState(input: {
  playerUserId: string;
  playerDisplayName: string;
}): ScenarioHostSessionState {
  return scenarioHostSessionStateSchema.parse({
    version: 5,
    profile: createEmptyScenarioProfile(),
    currentSituation: defaultScenarioCurrentSituation,
    currentLocation: null,
    sceneSummary: "",
    player: {
      userId: input.playerUserId,
      displayName: input.playerDisplayName,
      basicInfo: "",
      characterDescription: "",
      wornItems: [],
      heldItems: [],
      statusDescription: ""
    },
    objectives: [],
    loreEntries: [],
    npcs: [],
    entities: [],
    relations: [],
    journal: [],
    mechanics: {},
    flags: {},
    setupProgress: {},
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

export function getMissingScenarioRuntimeSetupFields(state: ScenarioHostSessionState): string[] {
  const missing: string[] = [];
  if (!state.player.basicInfo.trim()) {
    missing.push("玩家基础信息");
  }
  if (!state.player.characterDescription.trim()) {
    missing.push("玩家角色描述");
  }
  if (state.player.wornItems.length === 0) {
    missing.push("玩家穿着");
  }
  if (state.player.heldItems.length === 0) {
    missing.push("玩家持有物");
  }
  return missing;
}

export function isScenarioRuntimeSetupComplete(state: ScenarioHostSessionState): boolean {
  return getMissingScenarioRuntimeSetupFields(state).length === 0;
}

export function getMissingScenarioSetupFields(state: ScenarioHostSessionState): string[] {
  return [
    ...(isScenarioProfileComplete(state.profile) ? [] : ["Scenario 资料核心字段"]),
    ...getMissingScenarioRuntimeSetupFields(state)
  ];
}

export function isScenarioSetupComplete(state: ScenarioHostSessionState): boolean {
  return getMissingScenarioSetupFields(state).length === 0;
}

export function getScenarioInitializedStateViolations(state: ScenarioHostSessionState): string[] {
  if (!state.initialized) {
    return [];
  }
  const missing = getMissingScenarioSetupFields(state);
  return missing.length > 0
    ? [`已初始化场景缺少：${missing.join("、")}`]
    : [];
}

export function assertScenarioInitializedStateValid(state: ScenarioHostSessionState): void {
  const violations = getScenarioInitializedStateViolations(state);
  if (violations.length > 0) {
    throw new Error(`scenario_initialized_state_invalid: ${violations.join("；")}`);
  }
}

export function migrateScenarioHostSessionState(value: unknown): ScenarioHostSessionState {
  const raw = value as { version?: unknown; profile?: unknown };
  if (raw?.version === 5) {
    return scenarioHostSessionStateSchema.parse(raw);
  }
  if (raw?.version === 4) {
    return migrateScenarioHostV4(raw as LegacyScenarioHostSessionStateV4);
  }
  if (raw?.version === 3) {
    return migrateScenarioHostV3(raw as LegacyScenarioHostSessionStateV3);
  }
  if (raw?.version === 2) {
    const legacy = raw as LegacyScenarioHostSessionStateV2;
    const { worldFacts = [], inventory: _legacyInventoryField, ...state } = legacy;
    const legacyInventory = legacy.inventory ?? [];
    const player = migrateScenarioPlayer(legacy.player, legacyInventory);
    return scenarioHostSessionStateSchema.parse({
      ...state,
      version: 5,
      profile: legacy.profile ?? createEmptyScenarioProfile(),
      loreEntries: legacyWorldFactsToLoreEntries(worldFacts, legacy.turnIndex ?? 0),
      player,
      npcs: [],
      entities: legacyInventoryToItemEntities(legacyInventory, [player.userId]),
      relations: [],
      journal: [],
      mechanics: {}
    });
  }
  if (raw?.version === 1) {
    const legacy = raw as LegacyScenarioHostSessionStateV1;
    const { worldFacts = [], inventory: _legacyInventoryField, ...state } = legacy;
    const legacyInventory = legacy.inventory ?? [];
    const player = migrateScenarioPlayer(legacy.player, legacyInventory);
    return scenarioHostSessionStateSchema.parse({
      ...state,
      version: 5,
      profile: createEmptyScenarioProfile(),
      loreEntries: legacyWorldFactsToLoreEntries(worldFacts, legacy.turnIndex ?? 0),
      player,
      npcs: [],
      entities: legacyInventoryToItemEntities(legacyInventory, [player.userId]),
      relations: [],
      journal: [],
      mechanics: {}
    });
  }
  return scenarioHostSessionStateSchema.parse(raw);
}

function migrateScenarioHostV4(legacy: LegacyScenarioHostSessionStateV4): ScenarioHostSessionState {
  const inventory = legacy.inventory ?? [];
  const { inventory: _legacyInventoryField, ...state } = legacy;
  const player = migrateScenarioPlayer(legacy.player, inventory);
  const npcs = (legacy.npcs ?? []).map((npc) => migrateScenarioNpc(npc, inventory));
  const characterIds = [player.userId, ...npcs.map((npc) => npc.id)];
  const entities = legacy.entities ?? [];
  return scenarioHostSessionStateSchema.parse({
    ...state,
    version: 5,
    player,
    npcs,
    entities: [
      ...entities,
      ...legacyInventoryToItemEntities(inventory, characterIds, entities)
    ]
  });
}

function migrateScenarioHostV3(legacy: LegacyScenarioHostSessionStateV3): ScenarioHostSessionState {
  const inventory = legacy.inventory ?? [];
  const { inventory: _legacyInventoryField, entities: _legacyEntitiesField, ...state } = legacy;
  const player = migrateScenarioPlayer(legacy.player, inventory);
  const legacyEntities = legacy.entities ?? [];
  const npcIds = legacyEntities.filter((entity) => entity.kind === "npc").map((entity) => entity.id);
  return scenarioHostSessionStateSchema.parse({
    ...state,
    version: 5,
    player,
    npcs: legacyEntities
      .filter((entity) => entity.kind === "npc")
      .map((entity) => legacyEntityToNpc(entity, inventory)),
    entities: [
      ...legacyEntities
      .filter((entity) => entity.kind !== "npc")
      .map((entity) => ({
        ...entity,
        kind: entity.kind === "location" || entity.kind === "faction" || entity.kind === "item" || entity.kind === "organization" || entity.kind === "other"
          ? entity.kind
          : "other"
      })),
      ...legacyInventoryToItemEntities(inventory, [player.userId, ...npcIds], legacyEntities)
    ],
    mechanics: legacy.mechanics ?? {}
  });
}

function migrateScenarioPlayer(
  player: ScenarioHostPlayer | undefined,
  inventory: LegacyScenarioHostInventoryItem[] = []
): ScenarioHostPlayer {
  const userId = player?.userId ?? "unknown_user";
  return scenarioHostPlayerSchema.parse({
    userId,
    displayName: player?.displayName ?? "玩家",
    basicInfo: player?.basicInfo ?? "",
    characterDescription: player?.characterDescription ?? "",
    wornItems: player?.wornItems ?? [],
    heldItems: mergeLegacyInventoryHeldItems(userId, player?.heldItems ?? [], inventory),
    statusDescription: player?.statusDescription ?? ""
  });
}

function migrateScenarioNpc(npc: ScenarioHostNpc, inventory: LegacyScenarioHostInventoryItem[]): ScenarioHostNpc {
  return scenarioHostNpcSchema.parse({
    ...npc,
    heldItems: mergeLegacyInventoryHeldItems(npc.id, npc.heldItems, inventory)
  });
}

function mergeLegacyInventoryHeldItems(
  ownerId: string,
  heldItems: ScenarioHostHeldItem[],
  inventory: LegacyScenarioHostInventoryItem[]
): ScenarioHostHeldItem[] {
  return [
    ...heldItems,
    ...inventory
      .filter((item) => item.ownerId === ownerId)
      .map(inventoryItemToHeldItem)
  ];
}

function legacyEntityToNpc(entity: LegacyScenarioHostEntityV3, inventory: LegacyScenarioHostInventoryItem[]): ScenarioHostNpc {
  return scenarioHostNpcSchema.parse({
    id: entity.id,
    name: entity.name,
    aliases: entity.aliases ?? [],
    basicInfo: compactLegacyNpcText(entity.notes, entity.summary, entity.name),
    characterDescription: compactLegacyNpcText(entity.summary, entity.notes, entity.name),
    wornItems: [{
      name: "未记录穿着",
      wearPosition: "未记录",
      description: "旧版实体未记录具体穿着。"
    }],
    heldItems: inventory
      .filter((item) => item.ownerId === entity.id)
      .map(inventoryItemToHeldItem)
      .concat(inventory.some((item) => item.ownerId === entity.id)
        ? []
        : [{ name: "未记录持有物", description: "旧版实体未记录具体持有物。", quantity: 1 }]),
    statusDescription: entity.status ?? "",
    locationId: entity.locationId ?? null,
    tags: entity.tags ?? [],
    notes: entity.notes ?? ""
  });
}

function inventoryItemToHeldItem(item: LegacyScenarioHostInventoryItem): ScenarioHostHeldItem {
  return {
    name: item.item,
    description: "由旧版背包条目迁移，缺少更具体描述。",
    quantity: item.quantity
  };
}

function legacyInventoryToItemEntities(
  inventory: LegacyScenarioHostInventoryItem[],
  characterIds: string[],
  existingEntities: Array<Pick<ScenarioHostEntity, "id">> = []
): ScenarioHostEntity[] {
  const characterIdSet = new Set(characterIds);
  const usedIds = new Set(existingEntities.map((entity) => entity.id));
  const entities: ScenarioHostEntity[] = [];
  inventory
    .filter((item) => !characterIdSet.has(item.ownerId))
    .forEach((item, index) => {
      const id = uniqueLegacyInventoryEntityId(item, index, usedIds);
      usedIds.add(id);
      entities.push(scenarioHostEntitySchema.parse({
        id,
        kind: "item",
        name: item.item,
        aliases: [],
        summary: `旧版背包条目迁移而来的场景物品，原归属 ${item.ownerId}，数量 ${item.quantity}。`,
        status: "",
        locationId: null,
        tags: ["legacy-inventory"],
        notes: `由旧版 inventory 字段迁移；原 ownerId=${item.ownerId}。`
      }));
    });
  return entities;
}

function uniqueLegacyInventoryEntityId(
  item: LegacyScenarioHostInventoryItem,
  index: number,
  usedIds: Set<string>
): string {
  const base = `legacy-inventory-${slugifyLegacyIdPart(item.ownerId)}-${slugifyLegacyIdPart(item.item)}-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

function slugifyLegacyIdPart(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "item";
}

function compactLegacyNpcText(...parts: Array<string | undefined>): string {
  return parts.map((part) => part?.trim()).find(Boolean) ?? "旧版 NPC 信息未记录。";
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
