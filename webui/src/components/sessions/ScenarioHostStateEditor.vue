<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { sessionsApi } from "@/api/sessions";
import type {
  ScenarioHostEntity,
  ScenarioHostEntityKind,
  ScenarioHostJournalEntry,
  ScenarioHostLoreEntry,
  ScenarioHostSessionState
} from "@/api/types";
import { ApiError } from "@/api/client";
import { WorkbenchTabStrip } from "@workbench-kit/vue";

type ScenarioEditorTab = "profile" | "scene" | "objectives" | "inventory" | "lore" | "entities" | "journal" | "flags";
type FlagType = "string" | "number" | "boolean";

interface FlagEntry {
  key: string;
  type: FlagType;
  value: string;
}

const tabs: Array<{ id: ScenarioEditorTab; label: string }> = [
  { id: "profile", label: "Profile" },
  { id: "scene", label: "Scene" },
  { id: "objectives", label: "Objectives" },
  { id: "inventory", label: "Inventory" },
  { id: "lore", label: "Lore" },
  { id: "entities", label: "Entities" },
  { id: "journal", label: "Journal" },
  { id: "flags", label: "Flags" }
];

const entityKinds: Array<{ id: ScenarioHostEntityKind; label: string }> = [
  { id: "npc", label: "NPC" },
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
      || value === "objectives"
      || value === "inventory"
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
  return JSON.parse(JSON.stringify(state)) as ScenarioHostSessionState;
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function joinList(value: string[]): string {
  return value.join(", ");
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

function buildDraftState(): ScenarioHostSessionState {
  return {
    version: 3,
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
      displayName: draft.value.player.displayName.trim()
    },
    inventory: draft.value.inventory.map((item) => ({
      ownerId: item.ownerId.trim(),
      item: item.item.trim(),
      quantity: Math.max(1, Math.trunc(item.quantity || 1))
    })).filter((item) => item.ownerId && item.item),
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
    initialized: draft.value.initialized,
    turnIndex: Math.max(0, Math.trunc(draft.value.turnIndex || 0))
  };
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

function addInventoryItem() {
  draft.value.inventory.push({ ownerId: draft.value.player.userId || "", item: "", quantity: 1 });
}

function removeInventoryItem(index: number) {
  draft.value.inventory.splice(index, 1);
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
              玩家 ID
              <input v-model="draft.player.userId" class="input-base font-mono text-ui" />
            </label>
            <label class="flex flex-col gap-1.5 text-small text-text-muted">
              玩家显示名
              <input v-model="draft.player.displayName" class="input-base text-ui" />
            </label>
          </div>
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

        <div v-else-if="activeTab === 'inventory'" class="grid gap-3">
          <button class="btn btn-secondary justify-self-start" type="button" @click="addInventoryItem">新增物品</button>
          <div v-if="draft.inventory.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">暂无物品</div>
          <div v-for="(item, index) in draft.inventory" :key="`inventory-${index}`" class="grid gap-3 rounded border border-border-default bg-surface-sidebar p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_auto]">
            <input v-model="item.ownerId" class="input-base font-mono text-ui" placeholder="ownerId" />
            <input v-model="item.item" class="input-base text-ui" placeholder="item" />
            <input v-model.number="item.quantity" type="number" min="1" class="input-base text-ui" />
            <button class="btn btn-secondary" type="button" @click="removeInventoryItem(index)">删除</button>
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
            <div v-for="(entity, index) in draft.entities" :key="`entity-${index}`" class="grid gap-3 rounded border border-border-default bg-surface-sidebar p-3">
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
            </div>
          </section>

          <section class="grid gap-3">
            <button class="btn btn-secondary justify-self-start" type="button" @click="addRelation">新增关系</button>
            <div v-if="draft.relations.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">暂无关系</div>
            <div v-for="(relation, index) in draft.relations" :key="`relation-${index}`" class="grid gap-3 rounded border border-border-default bg-surface-sidebar p-3">
              <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_8rem_auto]">
                <input v-model="relation.sourceId" class="input-base font-mono text-ui" placeholder="sourceId" />
                <input v-model="relation.targetId" class="input-base font-mono text-ui" placeholder="targetId" />
                <input v-model="relation.kind" class="input-base text-ui" placeholder="kind" />
                <input v-model.number="relation.strength" type="number" min="-100" max="100" class="input-base text-ui" />
                <button class="btn btn-secondary" type="button" @click="removeRelation(index)">删除</button>
              </div>
              <textarea v-model="relation.summary" class="input-base min-h-20 resize-y text-ui leading-[1.4]" />
            </div>
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
