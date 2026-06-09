<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { sessionsApi } from "@/api/sessions";
import type {
  ScenarioHostEntity,
  ScenarioHostEntityKind,
  ScenarioHostHeldItem,
  ScenarioHostJournalEntry,
  ScenarioHostLoreEntry,
  ScenarioHostNpc,
  ScenarioSetupOptionalItemKey,
  ScenarioHostWornItem,
  ScenarioHostSessionState
} from "@/api/types";
import { ApiError } from "@/api/client";
import { WorkbenchDisclosure, WorkbenchTabStrip } from "@workbench-kit/vue";

type ScenarioEditorTab = "profile" | "scene" | "characters" | "objectives" | "lore" | "entities" | "journal" | "flags";
type FlagType = "string" | "number" | "boolean";

interface FlagEntry {
  key: string;
  type: FlagType;
  value: string;
}

const tabs: Array<{ id: ScenarioEditorTab; label: string }> = [
  { id: "profile", label: "Profile" },
  { id: "scene", label: "Scene" },
  { id: "characters", label: "Characters" },
  { id: "objectives", label: "Objectives" },
  { id: "lore", label: "Lore" },
  { id: "entities", label: "Entities" },
  { id: "journal", label: "Journal" },
  { id: "flags", label: "Flags" }
];

const entityKinds: Array<{ id: ScenarioHostEntityKind; label: string }> = [
  { id: "location", label: "地点" },
  { id: "faction", label: "阵营" },
  { id: "item", label: "物品" },
  { id: "organization", label: "组织" },
  { id: "other", label: "其他" }
];

const props = defineProps<{
  sessionId: string;
  state: ScenarioHostSessionState;
}>();

const emit = defineEmits<{
  saved: [state: ScenarioHostSessionState];
}>();

const activeTab = ref<ScenarioEditorTab>("profile");
const selectedTab = computed({
  get: () => activeTab.value,
  set: (value: string) => {
    if (
      value === "profile"
      || value === "scene"
      || value === "characters"
      || value === "objectives"
      || value === "lore"
      || value === "entities"
      || value === "journal"
      || value === "flags"
    ) {
      activeTab.value = value;
    }
  }
});
const draft = ref<ScenarioHostSessionState>(cloneState(props.state));
const flagEntries = ref<FlagEntry[]>(createFlagEntries(props.state.flags));
const disclosureStates = reactive<Record<string, boolean>>({
  "character:player": true
});
const rowDisclosureIds = new WeakMap<object, string>();
let rowDisclosureIdSequence = 0;
const saving = ref(false);
const errorMessage = ref("");

watch(() => props.state, (nextState) => {
  draft.value = cloneState(nextState);
  flagEntries.value = createFlagEntries(nextState.flags);
  errorMessage.value = "";
}, { deep: true, immediate: true });

const dirty = computed(() => {
  const nextState = tryBuildDraftState();
  return nextState ? JSON.stringify(nextState) !== JSON.stringify(props.state) : true;
});

function cloneState(state: ScenarioHostSessionState): ScenarioHostSessionState {
  const cloned = JSON.parse(JSON.stringify(state)) as ScenarioHostSessionState;
  return {
    ...cloned,
    setupProgress: {
      skippedOptionalItems: normalizeSkippedOptionalItems(cloned.setupProgress?.skippedOptionalItems ?? [])
    }
  };
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function joinList(value: string[]): string {
  return value.join(", ");
}

function isDisclosureExpanded(id: string, defaultExpanded = false): boolean {
  return disclosureStates[id] ?? defaultExpanded;
}

function toggleDisclosure(id: string, defaultExpanded = false): void {
  disclosureStates[id] = !isDisclosureExpanded(id, defaultExpanded);
}

function rowDisclosureId(scope: string, row: object): string {
  const existing = rowDisclosureIds.get(row);
  if (existing) {
    return existing;
  }
  const id = `${scope}:${rowDisclosureIdSequence++}`;
  rowDisclosureIds.set(row, id);
  return id;
}

function npcDisclosureId(npc: ScenarioHostNpc): string {
  return rowDisclosureId("character:npc", npc);
}

function entityDisclosureId(entity: ScenarioHostEntity): string {
  return rowDisclosureId("entity", entity);
}

function relationDisclosureId(relation: ScenarioHostSessionState["relations"][number]): string {
  return rowDisclosureId("relation", relation);
}

function compactSummary(parts: Array<string | null | undefined>): string | null {
  const normalized = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return normalized.length > 0 ? normalized.join(" · ") : null;
}

function playerSummary(): string | null {
  return compactSummary([
    draft.value.player.statusDescription,
    draft.value.player.wornItems.length > 0 ? `穿着 ${draft.value.player.wornItems.length}` : null,
    draft.value.player.heldItems.length > 0 ? `持有物 ${draft.value.player.heldItems.length}` : null
  ]);
}

function npcTitle(npc: ScenarioHostNpc, index: number): string {
  const label = npc.name.trim() || npc.id.trim() || `NPC #${index + 1}`;
  return `NPC · ${label}`;
}

function npcSummary(npc: ScenarioHostNpc): string | null {
  return compactSummary([
    npc.statusDescription,
    npc.locationId ? `地点 ${npc.locationId}` : null,
    npc.wornItems.length > 0 ? `穿着 ${npc.wornItems.length}` : null,
    npc.heldItems.length > 0 ? `持有物 ${npc.heldItems.length}` : null
  ]);
}

function entityKindLabel(kind: ScenarioHostEntityKind): string {
  return entityKinds.find((item) => item.id === kind)?.label ?? kind;
}

function entityTitle(entity: ScenarioHostEntity, index: number): string {
  const label = entity.name.trim() || entity.id.trim() || `实体 #${index + 1}`;
  return `${entityKindLabel(entity.kind)} · ${label}`;
}

function entitySummary(entity: ScenarioHostEntity): string | null {
  return compactSummary([
    entity.status,
    entity.locationId ? `地点 ${entity.locationId}` : null,
    entity.tags.length > 0 ? entity.tags.join(", ") : null
  ]);
}

function relationTitle(relation: ScenarioHostSessionState["relations"][number], index: number): string {
  const source = relation.sourceId.trim() || "source";
  const target = relation.targetId.trim() || "target";
  const kind = relation.kind.trim() || `关系 #${index + 1}`;
  return `${kind} · ${source} -> ${target}`;
}

function relationSummary(relation: ScenarioHostSessionState["relations"][number]): string | null {
  return compactSummary([
    `强度 ${relation.strength}`,
    relation.updatedAtTurn > 0 ? `回合 ${relation.updatedAtTurn}` : null
  ]);
}

function createFlagEntries(flags: ScenarioHostSessionState["flags"]): FlagEntry[] {
  return Object.entries(flags).map(([key, value]) => ({
    key,
    type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string",
    value: typeof value === "boolean" ? (value ? "true" : "false") : String(value)
  }));
}

function buildFlags(): ScenarioHostSessionState["flags"] {
  const nextFlags: ScenarioHostSessionState["flags"] = {};
  for (const entry of flagEntries.value) {
    const key = entry.key.trim();
    if (!key) {
      continue;
    }
    if (entry.type === "number") {
      const parsed = Number(entry.value.trim());
      if (!Number.isFinite(parsed)) {
        throw new Error(`标记 ${key} 需要有效数字`);
      }
      nextFlags[key] = parsed;
      continue;
    }
    if (entry.type === "boolean") {
      nextFlags[key] = entry.value === "true";
      continue;
    }
    nextFlags[key] = entry.value;
  }
  return nextFlags;
}

const scenarioSetupOptionalItemKeys = new Set<string>([
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
]);

function normalizeSkippedOptionalItems(items: string[]): ScenarioSetupOptionalItemKey[] {
  return Array.from(new Set(
    items.filter((item): item is ScenarioSetupOptionalItemKey => scenarioSetupOptionalItemKeys.has(item))
  ));
}

function buildDraftState(): ScenarioHostSessionState {
  const nextState: ScenarioHostSessionState = {
    version: 5,
    profile: {
      theme: draft.value.profile.theme,
      worldBaseline: draft.value.profile.worldBaseline,
      narrationStyle: draft.value.profile.narrationStyle,
      boundaries: draft.value.profile.boundaries
    },
    currentSituation: draft.value.currentSituation,
    currentLocation: draft.value.currentLocation?.trim() ? draft.value.currentLocation.trim() : null,
    sceneSummary: draft.value.sceneSummary,
    player: {
      userId: draft.value.player.userId.trim(),
      displayName: draft.value.player.displayName.trim(),
      basicInfo: draft.value.player.basicInfo,
      characterDescription: draft.value.player.characterDescription,
      wornItems: buildWornItems(draft.value.player.wornItems),
      heldItems: buildHeldItems(draft.value.player.heldItems),
      statusDescription: draft.value.player.statusDescription
    },
    objectives: draft.value.objectives.map((objective) => ({
      id: objective.id.trim(),
      title: objective.title.trim(),
      status: objective.status,
      summary: objective.summary
    })).filter((objective) => objective.id && objective.title),
    loreEntries: draft.value.loreEntries.map((entry) => ({
      id: entry.id.trim(),
      title: entry.title.trim(),
      content: entry.content,
      tags: entry.tags.map((tag) => tag.trim()).filter(Boolean),
      activationKeys: entry.activationKeys.map((key) => key.trim()).filter(Boolean),
      enabled: entry.enabled,
      priority: Math.trunc(entry.priority || 0),
      createdAtTurn: Math.max(0, Math.trunc(entry.createdAtTurn || 0)),
      updatedAtTurn: Math.max(0, Math.trunc(entry.updatedAtTurn || 0))
    })).filter((entry) => entry.id && entry.title),
    npcs: buildNpcs(draft.value.npcs),
    entities: draft.value.entities.map((entity) => ({
      id: entity.id.trim(),
      kind: entity.kind,
      name: entity.name.trim(),
      aliases: entity.aliases.map((alias) => alias.trim()).filter(Boolean),
      summary: entity.summary,
      status: entity.status,
      locationId: entity.locationId?.trim() ? entity.locationId.trim() : null,
      tags: entity.tags.map((tag) => tag.trim()).filter(Boolean),
      notes: entity.notes
    })).filter((entity) => entity.id && entity.name),
    relations: draft.value.relations.map((relation) => ({
      sourceId: relation.sourceId.trim(),
      targetId: relation.targetId.trim(),
      kind: relation.kind.trim(),
      summary: relation.summary,
      strength: Math.max(-100, Math.min(100, Math.trunc(relation.strength || 0))),
      updatedAtTurn: Math.max(0, Math.trunc(relation.updatedAtTurn || 0))
    })).filter((relation) => relation.sourceId && relation.targetId && relation.kind),
    journal: draft.value.journal.map((entry) => ({
      id: entry.id.trim(),
      turnIndex: Math.max(0, Math.trunc(entry.turnIndex || 0)),
      title: entry.title.trim(),
      summary: entry.summary,
      entityIds: entry.entityIds.map((id) => id.trim()).filter(Boolean),
      tags: entry.tags.map((tag) => tag.trim()).filter(Boolean),
      createdAtMs: Math.max(0, Math.trunc(entry.createdAtMs || 0))
    })).filter((entry) => entry.id && entry.title),
    mechanics: {
      ruleStyle: draft.value.mechanics.ruleStyle,
      dicePolicy: draft.value.mechanics.dicePolicy,
      difficultyScale: draft.value.mechanics.difficultyScale,
      successStates: draft.value.mechanics.successStates.map((item) => item.trim()).filter(Boolean)
    },
    flags: buildFlags(),
    setupProgress: {
      skippedOptionalItems: normalizeSkippedOptionalItems(draft.value.setupProgress?.skippedOptionalItems ?? [])
    },
    initialized: draft.value.initialized,
    turnIndex: Math.max(0, Math.trunc(draft.value.turnIndex || 0))
  };
  validateInitializedState(nextState);
  return nextState;
}

function buildWornItems(items: ScenarioHostWornItem[]): ScenarioHostWornItem[] {
  return items.map((item) => ({
    name: item.name.trim(),
    wearPosition: item.wearPosition.trim(),
    description: item.description.trim()
  })).filter((item) => item.name && item.wearPosition && item.description);
}

function buildHeldItems(items: ScenarioHostHeldItem[]): ScenarioHostHeldItem[] {
  return items.map((item) => ({
    name: item.name.trim(),
    description: item.description.trim(),
    quantity: Math.max(1, Math.trunc(item.quantity || 1))
  })).filter((item) => item.name && item.description);
}

function buildNpcs(npcs: ScenarioHostNpc[]): ScenarioHostNpc[] {
  return npcs.map((npc, index) => {
    const nextNpc: ScenarioHostNpc = {
      id: npc.id.trim(),
      name: npc.name.trim(),
      aliases: npc.aliases.map((alias) => alias.trim()).filter(Boolean),
      basicInfo: npc.basicInfo.trim(),
      characterDescription: npc.characterDescription.trim(),
      wornItems: buildWornItems(npc.wornItems),
      heldItems: buildHeldItems(npc.heldItems),
      statusDescription: npc.statusDescription,
      locationId: npc.locationId?.trim() ? npc.locationId.trim() : null,
      tags: npc.tags.map((tag) => tag.trim()).filter(Boolean),
      notes: npc.notes
    };
    const missing: string[] = [];
    if (!nextNpc.id) missing.push("id");
    if (!nextNpc.name) missing.push("name");
    if (!nextNpc.basicInfo) missing.push("basicInfo");
    if (!nextNpc.characterDescription) missing.push("characterDescription");
    if (nextNpc.wornItems.length === 0) missing.push("wornItems");
    if (nextNpc.heldItems.length === 0) missing.push("heldItems");
    if (missing.length > 0) {
      throw new Error(`NPC #${index + 1} 缺少必填字段：${missing.join("、")}`);
    }
    return nextNpc;
  });
}

function getMissingSetupFields(state: ScenarioHostSessionState): string[] {
  const missing: string[] = [];
  if (!state.profile.theme.trim() || !state.profile.worldBaseline.trim() || !state.profile.narrationStyle.trim()) {
    missing.push("Scenario 资料核心字段");
  }
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

function validateInitializedState(state: ScenarioHostSessionState) {
  if (!state.initialized) {
    return;
  }
  const missing = getMissingSetupFields(state);
  if (missing.length > 0) {
    throw new Error(`已初始化场景缺少：${missing.join("、")}`);
  }
}

function tryBuildDraftState(): ScenarioHostSessionState | null {
  try {
    return buildDraftState();
  } catch {
    return null;
  }
}

async function save() {
  if (saving.value || !dirty.value) {
    return;
  }
  saving.value = true;
  errorMessage.value = "";
  try {
    const response = await sessionsApi.updateModeState(props.sessionId, {
      state: buildDraftState(),
      baseState: props.state
    });
    emit("saved", response.modeState.state);
  } catch (error: unknown) {
    errorMessage.value = error instanceof ApiError || error instanceof Error
      ? error.message
      : "保存失败";
  } finally {
    saving.value = false;
  }
}

function resetDraft() {
  draft.value = cloneState(props.state);
  flagEntries.value = createFlagEntries(props.state.flags);
  errorMessage.value = "";
}

function addObjective() {
  draft.value.objectives.push({ id: "", title: "", status: "active", summary: "" });
}

function removeObjective(index: number) {
  draft.value.objectives.splice(index, 1);
}

function addWornItem(items: ScenarioHostWornItem[]) {
  items.push({ name: "", wearPosition: "", description: "" });
}

function removeWornItem(items: ScenarioHostWornItem[], index: number) {
  items.splice(index, 1);
}

function addHeldItem(items: ScenarioHostHeldItem[]) {
  items.push({ name: "", description: "", quantity: 1 });
}

function removeHeldItem(items: ScenarioHostHeldItem[], index: number) {
  items.splice(index, 1);
}

function addNpc() {
  const index = draft.value.npcs.length + 1;
  draft.value.npcs.push({
    id: `npc-${index}`,
    name: "",
    aliases: [],
    basicInfo: "",
    characterDescription: "",
    wornItems: [{ name: "", wearPosition: "", description: "" }],
    heldItems: [{ name: "", description: "", quantity: 1 }],
    statusDescription: "",
    locationId: null,
    tags: [],
    notes: ""
  });
  const npc = draft.value.npcs[index - 1];
  if (npc) {
    disclosureStates[npcDisclosureId(npc)] = true;
  }
}

function removeNpc(index: number) {
  draft.value.npcs.splice(index, 1);
}

function updateNpcAliases(npc: ScenarioHostNpc, value: string) {
  npc.aliases = splitList(value);
}

function updateNpcTags(npc: ScenarioHostNpc, value: string) {
  npc.tags = splitList(value);
}

function addLoreEntry() {
  const index = draft.value.loreEntries.length + 1;
  draft.value.loreEntries.push({
    id: `lore-${index}`,
    title: "",
    content: "",
    tags: [],
    activationKeys: [],
    enabled: true,
    priority: 100,
    createdAtTurn: draft.value.turnIndex,
    updatedAtTurn: draft.value.turnIndex
  });
}

function removeLoreEntry(index: number) {
  draft.value.loreEntries.splice(index, 1);
}

function updateLoreTags(entry: ScenarioHostLoreEntry, value: string) {
  entry.tags = splitList(value);
}

function updateLoreActivationKeys(entry: ScenarioHostLoreEntry, value: string) {
  entry.activationKeys = splitList(value);
}

function addEntity() {
  const index = draft.value.entities.length + 1;
  draft.value.entities.push({
    id: `entity-${index}`,
    kind: "other",
    name: "",
    aliases: [],
    summary: "",
    status: "",
    locationId: null,
    tags: [],
    notes: ""
  });
  const entity = draft.value.entities[index - 1];
  if (entity) {
    disclosureStates[entityDisclosureId(entity)] = true;
  }
}

function removeEntity(index: number) {
  draft.value.entities.splice(index, 1);
}

function updateEntityAliases(entity: ScenarioHostEntity, value: string) {
  entity.aliases = splitList(value);
}

function updateEntityTags(entity: ScenarioHostEntity, value: string) {
  entity.tags = splitList(value);
}

function addRelation() {
  draft.value.relations.push({
    sourceId: "",
    targetId: "",
    kind: "",
    summary: "",
    strength: 0,
    updatedAtTurn: draft.value.turnIndex
  });
  const relation = draft.value.relations[draft.value.relations.length - 1];
  if (relation) {
    disclosureStates[relationDisclosureId(relation)] = true;
  }
}

function removeRelation(index: number) {
  draft.value.relations.splice(index, 1);
}

function addJournalEntry() {
  const index = draft.value.journal.length + 1;
  draft.value.journal.push({
    id: `journal-${index}`,
    turnIndex: draft.value.turnIndex,
    title: "",
    summary: "",
    entityIds: [],
    tags: [],
    createdAtMs: Date.now()
  });
}

function removeJournalEntry(index: number) {
  draft.value.journal.splice(index, 1);
}

function updateJournalEntityIds(entry: ScenarioHostJournalEntry, value: string) {
  entry.entityIds = splitList(value);
}

function updateJournalTags(entry: ScenarioHostJournalEntry, value: string) {
  entry.tags = splitList(value);
}

function addFlag() {
  flagEntries.value.push({ key: "", type: "string", value: "" });
}

function removeFlag(index: number) {
  flagEntries.value.splice(index, 1);
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-panel">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border-default px-4 py-3">
      <div class="min-w-0">
        <div class="text-ui font-medium text-text-secondary">Scenario</div>
        <div class="mt-1 text-small text-text-muted">version {{ state.version }} · turn {{ state.turnIndex }}</div>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn btn-secondary" type="button" :disabled="saving || !dirty" @click="resetDraft">
          重置
        </button>
        <button class="btn btn-primary" type="button" :disabled="saving || !dirty" @click="save">
          {{ saving ? "保存中…" : "保存" }}
        </button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <WorkbenchTabStrip v-model="selectedTab" :items="tabs" size="sm" bordered />

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div
          v-if="errorMessage"
          class="mb-4 rounded border border-[color-mix(in_srgb,var(--danger)_55%,transparent)] bg-surface-danger px-3 py-2 text-small text-danger"
        >
          {{ errorMessage }}
        </div>

        <div v-if="activeTab === 'profile'" class="grid gap-4">
          <label class="flex flex-col gap-1.5 text-small text-text-muted">
            主题
            <input v-model="draft.profile.theme" class="input-base text-ui" />
          </label>
          <label class="flex flex-col gap-1.5 text-small text-text-muted">
            世界基线
            <textarea v-model="draft.profile.worldBaseline" class="input-base min-h-28 resize-y text-ui leading-[1.4]" />
          </label>
          <label class="flex flex-col gap-1.5 text-small text-text-muted">
            叙事风格
            <textarea v-model="draft.profile.narrationStyle" class="input-base min-h-24 resize-y text-ui leading-[1.4]" />
          </label>
          <label class="flex flex-col gap-1.5 text-small text-text-muted">
            边界
            <textarea v-model="draft.profile.boundaries" class="input-base min-h-24 resize-y text-ui leading-[1.4]" />
          </label>
        </div>

        <div v-else-if="activeTab === 'scene'" class="grid gap-4">
          <div class="grid gap-4 md:grid-cols-2">
            <label class="flex flex-col gap-1.5 text-small text-text-muted">
              当前地点
              <input v-model="draft.currentLocation" class="input-base text-ui" />
            </label>
            <label class="flex flex-col gap-1.5 text-small text-text-muted">
              回合数
              <input v-model.number="draft.turnIndex" type="number" min="0" class="input-base text-ui" />
            </label>
          </div>
          <label class="flex items-center gap-2 text-small text-text-muted">
            <input v-model="draft.initialized" type="checkbox" />
            已初始化
          </label>
          <label class="flex flex-col gap-1.5 text-small text-text-muted">
            当前情境
            <textarea v-model="draft.currentSituation" class="input-base min-h-28 resize-y text-ui leading-[1.4]" />
          </label>
          <label class="flex flex-col gap-1.5 text-small text-text-muted">
            场景摘要
            <textarea v-model="draft.sceneSummary" class="input-base min-h-24 resize-y text-ui leading-[1.4]" />
          </label>
          <div class="grid gap-4 md:grid-cols-2">
            <label class="flex flex-col gap-1.5 text-small text-text-muted">
              规则风格
              <select v-model="draft.mechanics.ruleStyle" class="input-base text-ui">
                <option value="freeform">freeform</option>
                <option value="light_checks">light_checks</option>
                <option value="dice">dice</option>
              </select>
            </label>
            <label class="flex flex-col gap-1.5 text-small text-text-muted">
              成功状态
              <input :value="joinList(draft.mechanics.successStates)" class="input-base text-ui" @input="draft.mechanics.successStates = splitList(($event.target as HTMLInputElement).value)" />
            </label>
          </div>
          <label class="flex flex-col gap-1.5 text-small text-text-muted">
            骰子策略
            <textarea v-model="draft.mechanics.dicePolicy" class="input-base min-h-20 resize-y text-ui leading-[1.4]" />
          </label>
          <label class="flex flex-col gap-1.5 text-small text-text-muted">
            难度尺度
            <textarea v-model="draft.mechanics.difficultyScale" class="input-base min-h-20 resize-y text-ui leading-[1.4]" />
          </label>
        </div>

        <div v-else-if="activeTab === 'characters'" class="grid gap-4">
          <WorkbenchDisclosure
            :expanded="isDisclosureExpanded('character:player', true)"
            collapsed-title="玩家角色"
            expanded-title="玩家角色"
            :summary="playerSummary()"
            max-body-height-class="max-h-none"
            body-class="gap-3"
            @toggle="toggleDisclosure('character:player', true)"
          >
            <div class="grid gap-3 md:grid-cols-2">
              <label class="flex flex-col gap-1.5 text-small text-text-muted">
                玩家 ID
                <input v-model="draft.player.userId" class="input-base font-mono text-ui" />
              </label>
              <label class="flex flex-col gap-1.5 text-small text-text-muted">
                玩家显示名
                <input v-model="draft.player.displayName" class="input-base text-ui" />
              </label>
            </div>
            <label class="flex flex-col gap-1.5 text-small text-text-muted">
              基础信息
              <textarea v-model="draft.player.basicInfo" class="input-base min-h-20 resize-y text-ui leading-[1.4]" />
            </label>
            <label class="flex flex-col gap-1.5 text-small text-text-muted">
              角色描述
              <textarea v-model="draft.player.characterDescription" class="input-base min-h-24 resize-y text-ui leading-[1.4]" />
            </label>
            <label class="flex flex-col gap-1.5 text-small text-text-muted">
              临时状态
              <input v-model="draft.player.statusDescription" class="input-base text-ui" />
            </label>

            <div class="grid gap-2">
              <div class="flex items-center justify-between gap-2">
                <div class="text-small font-medium text-text-secondary">穿着</div>
                <button class="btn btn-secondary" type="button" @click="addWornItem(draft.player.wornItems)">新增穿着</button>
              </div>
              <div v-if="draft.player.wornItems.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">暂无穿着</div>
              <div v-for="(item, index) in draft.player.wornItems" :key="`player-worn-${index}`" class="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem_minmax(0,2fr)_auto]">
                <input v-model="item.name" class="input-base text-ui" placeholder="名称" />
                <input v-model="item.wearPosition" class="input-base text-ui" placeholder="位置" />
                <input v-model="item.description" class="input-base text-ui" placeholder="描述" />
                <button class="btn btn-secondary" type="button" @click="removeWornItem(draft.player.wornItems, index)">删除</button>
              </div>
            </div>

            <div class="grid gap-2">
              <div class="flex items-center justify-between gap-2">
                <div class="text-small font-medium text-text-secondary">持有物</div>
                <button class="btn btn-secondary" type="button" @click="addHeldItem(draft.player.heldItems)">新增持有物</button>
              </div>
              <div v-if="draft.player.heldItems.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">暂无持有物</div>
              <div v-for="(item, index) in draft.player.heldItems" :key="`player-held-${index}`" class="grid gap-2 md:grid-cols-[minmax(0,1fr)_7rem_minmax(0,2fr)_auto]">
                <input v-model="item.name" class="input-base text-ui" placeholder="名称" />
                <input v-model.number="item.quantity" type="number" min="1" class="input-base text-ui" />
                <input v-model="item.description" class="input-base text-ui" placeholder="描述" />
                <button class="btn btn-secondary" type="button" @click="removeHeldItem(draft.player.heldItems, index)">删除</button>
              </div>
            </div>
          </WorkbenchDisclosure>

          <section class="grid gap-3">
            <button class="btn btn-secondary justify-self-start" type="button" @click="addNpc">新增 NPC</button>
            <div v-if="draft.npcs.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">暂无 NPC</div>
            <WorkbenchDisclosure
              v-for="(npc, npcIndex) in draft.npcs"
              :key="npcDisclosureId(npc)"
              :expanded="isDisclosureExpanded(npcDisclosureId(npc))"
              :collapsed-title="npcTitle(npc, npcIndex)"
              :expanded-title="npcTitle(npc, npcIndex)"
              :summary="npcSummary(npc)"
              max-body-height-class="max-h-none"
              body-class="gap-3"
              @toggle="toggleDisclosure(npcDisclosureId(npc))"
            >
              <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                <input v-model="npc.id" class="input-base font-mono text-ui" placeholder="id" />
                <input v-model="npc.name" class="input-base text-ui" placeholder="name" />
                <input v-model="npc.locationId" class="input-base font-mono text-ui" placeholder="locationId" />
                <button class="btn btn-secondary" type="button" @click="removeNpc(npcIndex)">删除</button>
              </div>
              <div class="grid gap-3 md:grid-cols-3">
                <input :value="joinList(npc.aliases)" class="input-base text-ui" placeholder="aliases" @input="updateNpcAliases(npc, ($event.target as HTMLInputElement).value)" />
                <input v-model="npc.statusDescription" class="input-base text-ui" placeholder="statusDescription" />
                <input :value="joinList(npc.tags)" class="input-base text-ui" placeholder="tags" @input="updateNpcTags(npc, ($event.target as HTMLInputElement).value)" />
              </div>
              <textarea v-model="npc.basicInfo" class="input-base min-h-20 resize-y text-ui leading-[1.4]" placeholder="basicInfo" />
              <textarea v-model="npc.characterDescription" class="input-base min-h-24 resize-y text-ui leading-[1.4]" placeholder="characterDescription" />
              <textarea v-model="npc.notes" class="input-base min-h-20 resize-y text-ui leading-[1.4]" placeholder="notes" />

              <div class="grid gap-2">
                <div class="flex items-center justify-between gap-2">
                  <div class="text-small font-medium text-text-secondary">穿着</div>
                  <button class="btn btn-secondary" type="button" @click="addWornItem(npc.wornItems)">新增穿着</button>
                </div>
                <div v-for="(item, itemIndex) in npc.wornItems" :key="`npc-worn-${npcIndex}-${itemIndex}`" class="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem_minmax(0,2fr)_auto]">
                  <input v-model="item.name" class="input-base text-ui" placeholder="名称" />
                  <input v-model="item.wearPosition" class="input-base text-ui" placeholder="位置" />
                  <input v-model="item.description" class="input-base text-ui" placeholder="描述" />
                  <button class="btn btn-secondary" type="button" @click="removeWornItem(npc.wornItems, itemIndex)">删除</button>
                </div>
              </div>

              <div class="grid gap-2">
                <div class="flex items-center justify-between gap-2">
                  <div class="text-small font-medium text-text-secondary">持有物</div>
                  <button class="btn btn-secondary" type="button" @click="addHeldItem(npc.heldItems)">新增持有物</button>
                </div>
                <div v-for="(item, itemIndex) in npc.heldItems" :key="`npc-held-${npcIndex}-${itemIndex}`" class="grid gap-2 md:grid-cols-[minmax(0,1fr)_7rem_minmax(0,2fr)_auto]">
                  <input v-model="item.name" class="input-base text-ui" placeholder="名称" />
                  <input v-model.number="item.quantity" type="number" min="1" class="input-base text-ui" />
                  <input v-model="item.description" class="input-base text-ui" placeholder="描述" />
                  <button class="btn btn-secondary" type="button" @click="removeHeldItem(npc.heldItems, itemIndex)">删除</button>
                </div>
              </div>
            </WorkbenchDisclosure>
          </section>
        </div>

        <div v-else-if="activeTab === 'objectives'" class="grid gap-3">
          <button class="btn btn-secondary justify-self-start" type="button" @click="addObjective">新增目标</button>
          <div v-if="draft.objectives.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">暂无目标</div>
          <div v-for="(objective, index) in draft.objectives" :key="`objective-${index}`" class="grid gap-3 rounded border border-border-default bg-surface-sidebar p-3">
            <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_auto]">
              <input v-model="objective.id" class="input-base font-mono text-ui" placeholder="id" />
              <input v-model="objective.title" class="input-base text-ui" placeholder="title" />
              <select v-model="objective.status" class="input-base text-ui">
                <option value="active">active</option>
                <option value="completed">completed</option>
                <option value="failed">failed</option>
              </select>
              <button class="btn btn-secondary" type="button" @click="removeObjective(index)">删除</button>
            </div>
            <textarea v-model="objective.summary" class="input-base min-h-20 resize-y text-ui leading-[1.4]" />
          </div>
        </div>

        <div v-else-if="activeTab === 'lore'" class="grid gap-3">
          <button class="btn btn-secondary justify-self-start" type="button" @click="addLoreEntry">新增 Lore</button>
          <div v-if="draft.loreEntries.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">暂无 Lore</div>
          <div v-for="(entry, index) in draft.loreEntries" :key="`lore-${index}`" class="grid gap-3 rounded border border-border-default bg-surface-sidebar p-3">
            <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_7rem_auto]">
              <input v-model="entry.id" class="input-base font-mono text-ui" placeholder="id" />
              <input v-model="entry.title" class="input-base text-ui" placeholder="title" />
              <input v-model.number="entry.priority" type="number" class="input-base text-ui" />
              <label class="flex items-center gap-2 text-small text-text-muted">
                <input v-model="entry.enabled" type="checkbox" />
                enabled
              </label>
              <button class="btn btn-secondary" type="button" @click="removeLoreEntry(index)">删除</button>
            </div>
            <textarea v-model="entry.content" class="input-base min-h-24 resize-y text-ui leading-[1.4]" />
            <div class="grid gap-3 md:grid-cols-2">
              <input :value="joinList(entry.activationKeys)" class="input-base text-ui" placeholder="activation keys" @input="updateLoreActivationKeys(entry, ($event.target as HTMLInputElement).value)" />
              <input :value="joinList(entry.tags)" class="input-base text-ui" placeholder="tags" @input="updateLoreTags(entry, ($event.target as HTMLInputElement).value)" />
            </div>
          </div>
        </div>

        <div v-else-if="activeTab === 'entities'" class="grid gap-4">
          <section class="grid gap-3">
            <button class="btn btn-secondary justify-self-start" type="button" @click="addEntity">新增实体</button>
            <div v-if="draft.entities.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">暂无实体</div>
            <WorkbenchDisclosure
              v-for="(entity, index) in draft.entities"
              :key="entityDisclosureId(entity)"
              :expanded="isDisclosureExpanded(entityDisclosureId(entity))"
              :collapsed-title="entityTitle(entity, index)"
              :expanded-title="entityTitle(entity, index)"
              :summary="entitySummary(entity)"
              max-body-height-class="max-h-none"
              body-class="gap-3"
              @toggle="toggleDisclosure(entityDisclosureId(entity))"
            >
              <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_minmax(0,1fr)_auto]">
                <input v-model="entity.id" class="input-base font-mono text-ui" placeholder="id" />
                <select v-model="entity.kind" class="input-base text-ui">
                  <option v-for="kind in entityKinds" :key="kind.id" :value="kind.id">{{ kind.label }}</option>
                </select>
                <input v-model="entity.name" class="input-base text-ui" placeholder="name" />
                <button class="btn btn-secondary" type="button" @click="removeEntity(index)">删除</button>
              </div>
              <div class="grid gap-3 md:grid-cols-3">
                <input :value="joinList(entity.aliases)" class="input-base text-ui" placeholder="aliases" @input="updateEntityAliases(entity, ($event.target as HTMLInputElement).value)" />
                <input v-model="entity.status" class="input-base text-ui" placeholder="status" />
                <input v-model="entity.locationId" class="input-base font-mono text-ui" placeholder="locationId" />
              </div>
              <textarea v-model="entity.summary" class="input-base min-h-20 resize-y text-ui leading-[1.4]" placeholder="summary" />
              <textarea v-model="entity.notes" class="input-base min-h-20 resize-y text-ui leading-[1.4]" placeholder="notes" />
              <input :value="joinList(entity.tags)" class="input-base text-ui" placeholder="tags" @input="updateEntityTags(entity, ($event.target as HTMLInputElement).value)" />
            </WorkbenchDisclosure>
          </section>

          <section class="grid gap-3">
            <button class="btn btn-secondary justify-self-start" type="button" @click="addRelation">新增关系</button>
            <div v-if="draft.relations.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">暂无关系</div>
            <WorkbenchDisclosure
              v-for="(relation, index) in draft.relations"
              :key="relationDisclosureId(relation)"
              :expanded="isDisclosureExpanded(relationDisclosureId(relation))"
              :collapsed-title="relationTitle(relation, index)"
              :expanded-title="relationTitle(relation, index)"
              :summary="relationSummary(relation)"
              max-body-height-class="max-h-none"
              body-class="gap-3"
              @toggle="toggleDisclosure(relationDisclosureId(relation))"
            >
              <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_8rem_auto]">
                <input v-model="relation.sourceId" class="input-base font-mono text-ui" placeholder="sourceId" />
                <input v-model="relation.targetId" class="input-base font-mono text-ui" placeholder="targetId" />
                <input v-model="relation.kind" class="input-base text-ui" placeholder="kind" />
                <input v-model.number="relation.strength" type="number" min="-100" max="100" class="input-base text-ui" />
                <button class="btn btn-secondary" type="button" @click="removeRelation(index)">删除</button>
              </div>
              <textarea v-model="relation.summary" class="input-base min-h-20 resize-y text-ui leading-[1.4]" />
            </WorkbenchDisclosure>
          </section>
        </div>

        <div v-else-if="activeTab === 'journal'" class="grid gap-3">
          <button class="btn btn-secondary justify-self-start" type="button" @click="addJournalEntry">新增日志</button>
          <div v-if="draft.journal.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">暂无日志</div>
          <div v-for="(entry, index) in draft.journal" :key="`journal-${index}`" class="grid gap-3 rounded border border-border-default bg-surface-sidebar p-3">
            <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_auto]">
              <input v-model="entry.id" class="input-base font-mono text-ui" placeholder="id" />
              <input v-model.number="entry.turnIndex" type="number" min="0" class="input-base text-ui" />
              <input v-model="entry.title" class="input-base text-ui" placeholder="title" />
              <button class="btn btn-secondary" type="button" @click="removeJournalEntry(index)">删除</button>
            </div>
            <textarea v-model="entry.summary" class="input-base min-h-24 resize-y text-ui leading-[1.4]" />
            <div class="grid gap-3 md:grid-cols-2">
              <input :value="joinList(entry.entityIds)" class="input-base text-ui" placeholder="entity ids" @input="updateJournalEntityIds(entry, ($event.target as HTMLInputElement).value)" />
              <input :value="joinList(entry.tags)" class="input-base text-ui" placeholder="tags" @input="updateJournalTags(entry, ($event.target as HTMLInputElement).value)" />
            </div>
          </div>
        </div>

        <div v-else-if="activeTab === 'flags'" class="grid gap-3">
          <button class="btn btn-secondary justify-self-start" type="button" @click="addFlag">新增标记</button>
          <div v-if="flagEntries.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">暂无标记</div>
          <div v-for="(entry, index) in flagEntries" :key="`flag-${index}`" class="grid gap-3 rounded border border-border-default bg-surface-sidebar p-3 md:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_auto]">
            <input v-model="entry.key" class="input-base font-mono text-ui" placeholder="key" />
            <select v-model="entry.type" class="input-base text-ui">
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
            </select>
            <select v-if="entry.type === 'boolean'" v-model="entry.value" class="input-base text-ui">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
            <input v-else v-model="entry.value" class="input-base text-ui" placeholder="value" />
            <button class="btn btn-secondary" type="button" @click="removeFlag(index)">删除</button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
