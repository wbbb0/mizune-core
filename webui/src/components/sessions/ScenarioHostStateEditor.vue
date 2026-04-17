<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { sessionsApi } from "@/api/sessions";
import type { ScenarioHostSessionState } from "@/api/types";
import { ApiError } from "@/api/client";

type FlagType = "string" | "number" | "boolean";

interface FlagEntry {
  key: string;
  type: FlagType;
  value: string;
}

const props = defineProps<{
  sessionId: string;
  state: ScenarioHostSessionState;
}>();

const emit = defineEmits<{
  saved: [state: ScenarioHostSessionState];
}>();

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
  if (!nextState) {
    return true;
  }
  return JSON.stringify(nextState) !== JSON.stringify(props.state);
});

function cloneState(state: ScenarioHostSessionState): ScenarioHostSessionState {
  return JSON.parse(JSON.stringify(state)) as ScenarioHostSessionState;
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
    ...draft.value,
    title: draft.value.title,
    currentSituation: draft.value.currentSituation,
    currentLocation: draft.value.currentLocation?.trim() ? draft.value.currentLocation.trim() : null,
    sceneSummary: draft.value.sceneSummary,
    player: {
      userId: draft.value.player.userId,
      displayName: draft.value.player.displayName
    },
    inventory: draft.value.inventory.map((item) => ({
      ownerId: item.ownerId,
      item: item.item,
      quantity: Math.max(1, Math.trunc(item.quantity || 1))
    })),
    objectives: draft.value.objectives.map((objective) => ({
      id: objective.id,
      title: objective.title,
      status: objective.status,
      summary: objective.summary
    })),
    worldFacts: draft.value.worldFacts.map((fact) => fact),
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
      state: buildDraftState()
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

function onCurrentLocationInput(event: Event) {
  draft.value.currentLocation = (event.target as HTMLInputElement).value;
}

function addObjective() {
  draft.value.objectives.push({
    id: "",
    title: "",
    status: "active",
    summary: ""
  });
}

function removeObjective(index: number) {
  draft.value.objectives.splice(index, 1);
}

function addInventoryItem() {
  draft.value.inventory.push({
    ownerId: draft.value.player.userId || "",
    item: "",
    quantity: 1
  });
}

function removeInventoryItem(index: number) {
  draft.value.inventory.splice(index, 1);
}

function addWorldFact() {
  draft.value.worldFacts.push("");
}

function removeWorldFact(index: number) {
  draft.value.worldFacts.splice(index, 1);
}

function addFlag() {
  flagEntries.value.push({
    key: "",
    type: "string",
    value: ""
  });
}

function removeFlag(index: number) {
  flagEntries.value.splice(index, 1);
}
</script>

<template>
  <section class="flex flex-col gap-4 rounded-lg border border-border-default bg-surface-panel p-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div class="text-ui font-medium text-text-secondary">Scenario Host 状态</div>
        <div class="mt-1 text-small text-text-muted">这里直接管理结构化场景状态，不经过模型工具调用。</div>
      </div>
      <div class="flex items-center gap-2">
        <span class="rounded-full bg-surface-muted px-2 py-0.5 text-small text-text-subtle">version {{ state.version }}</span>
        <button class="btn btn-secondary" type="button" :disabled="saving || !dirty" @click="resetDraft">
          重置
        </button>
        <button class="btn btn-primary" type="button" :disabled="saving || !dirty" @click="save">
          {{ saving ? "保存中…" : "保存状态" }}
        </button>
      </div>
    </div>

    <div
      v-if="errorMessage"
      class="rounded border border-[color:color-mix(in_srgb,var(--danger)_55%,transparent)] bg-surface-danger px-3 py-2 text-small text-danger"
    >
      {{ errorMessage }}
    </div>

    <div class="grid gap-4 md:grid-cols-2">
      <label class="flex flex-col gap-1.5 text-small text-text-muted">
        场景标题
        <input v-model="draft.title" class="input-base text-ui" />
      </label>

      <label class="flex flex-col gap-1.5 text-small text-text-muted">
        当前地点
        <input :value="draft.currentLocation ?? ''" class="input-base text-ui" @input="onCurrentLocationInput" />
      </label>

      <label class="flex flex-col gap-1.5 text-small text-text-muted md:col-span-2">
        当前情境
        <textarea v-model="draft.currentSituation" class="input-base min-h-24 resize-y text-ui leading-[1.4]" />
      </label>

      <label class="flex flex-col gap-1.5 text-small text-text-muted md:col-span-2">
        场景摘要
        <textarea v-model="draft.sceneSummary" class="input-base min-h-20 resize-y text-ui leading-[1.4]" />
      </label>
    </div>

    <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
      <label class="flex flex-col gap-1.5 text-small text-text-muted">
        玩家 ID
        <input v-model="draft.player.userId" class="input-base font-mono text-ui" />
      </label>

      <label class="flex flex-col gap-1.5 text-small text-text-muted">
        玩家显示名
        <input v-model="draft.player.displayName" class="input-base text-ui" />
      </label>

      <label class="flex flex-col gap-1.5 text-small text-text-muted">
        回合数
        <input v-model.number="draft.turnIndex" type="number" min="0" class="input-base max-w-28 text-ui" />
      </label>

      <label class="flex items-center gap-2 self-end pb-1 text-small text-text-muted">
        <input v-model="draft.initialized" type="checkbox" />
        已初始化
      </label>
    </div>

    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <div class="text-ui font-medium text-text-secondary">目标</div>
        <button class="btn btn-secondary" type="button" @click="addObjective">添加目标</button>
      </div>
      <div v-if="draft.objectives.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">
        暂无目标
      </div>
      <div v-for="(objective, index) in draft.objectives" :key="`objective-${index}`" class="grid gap-3 rounded-lg border border-border-default bg-surface-sidebar p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <label class="flex flex-col gap-1 text-small text-text-muted">
          标识
          <input v-model="objective.id" class="input-base font-mono text-ui" />
        </label>
        <label class="flex flex-col gap-1 text-small text-text-muted">
          标题
          <input v-model="objective.title" class="input-base text-ui" />
        </label>
        <div class="flex items-end">
          <button class="btn btn-secondary" type="button" @click="removeObjective(index)">删除</button>
        </div>
        <label class="flex flex-col gap-1 text-small text-text-muted">
          状态
          <select v-model="objective.status" class="input-base text-ui">
            <option value="active">active</option>
            <option value="completed">completed</option>
            <option value="failed">failed</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-small text-text-muted md:col-span-2">
          摘要
          <textarea v-model="objective.summary" class="input-base min-h-18 resize-y text-ui leading-[1.4]" />
        </label>
      </div>
    </div>

    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <div class="text-ui font-medium text-text-secondary">背包</div>
        <button class="btn btn-secondary" type="button" @click="addInventoryItem">添加物品</button>
      </div>
      <div v-if="draft.inventory.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">
        暂无物品
      </div>
      <div v-for="(item, index) in draft.inventory" :key="`inventory-${index}`" class="grid gap-3 rounded-lg border border-border-default bg-surface-sidebar p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_auto]">
        <label class="flex flex-col gap-1 text-small text-text-muted">
          所有者 ID
          <input v-model="item.ownerId" class="input-base font-mono text-ui" />
        </label>
        <label class="flex flex-col gap-1 text-small text-text-muted">
          物品
          <input v-model="item.item" class="input-base text-ui" />
        </label>
        <label class="flex flex-col gap-1 text-small text-text-muted">
          数量
          <input v-model.number="item.quantity" type="number" min="1" class="input-base text-ui" />
        </label>
        <div class="flex items-end">
          <button class="btn btn-secondary" type="button" @click="removeInventoryItem(index)">删除</button>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <div class="text-ui font-medium text-text-secondary">世界事实</div>
        <button class="btn btn-secondary" type="button" @click="addWorldFact">添加事实</button>
      </div>
      <div v-if="draft.worldFacts.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">
        暂无世界事实
      </div>
      <div v-for="(fact, index) in draft.worldFacts" :key="`fact-${index}`" class="flex items-start gap-3 rounded-lg border border-border-default bg-surface-sidebar p-3">
        <textarea v-model="draft.worldFacts[index]" class="input-base min-h-18 flex-1 resize-y text-ui leading-[1.4]" />
        <button class="btn btn-secondary" type="button" @click="removeWorldFact(index)">删除</button>
      </div>
    </div>

    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <div class="text-ui font-medium text-text-secondary">标记</div>
        <button class="btn btn-secondary" type="button" @click="addFlag">添加标记</button>
      </div>
      <div v-if="flagEntries.length === 0" class="rounded border border-dashed border-border-default px-3 py-3 text-small text-text-subtle">
        暂无标记
      </div>
      <div v-for="(flag, index) in flagEntries" :key="`flag-${index}`" class="grid gap-3 rounded-lg border border-border-default bg-surface-sidebar p-3 md:grid-cols-[minmax(0,1fr)_150px_minmax(0,1fr)_auto]">
        <label class="flex flex-col gap-1 text-small text-text-muted">
          Key
          <input v-model="flag.key" class="input-base font-mono text-ui" />
        </label>
        <label class="flex flex-col gap-1 text-small text-text-muted">
          类型
          <select v-model="flag.type" class="input-base text-ui">
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-small text-text-muted">
          值
          <select v-if="flag.type === 'boolean'" v-model="flag.value" class="input-base text-ui">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
          <input v-else v-model="flag.value" class="input-base text-ui" />
        </label>
        <div class="flex items-end">
          <button class="btn btn-secondary" type="button" @click="removeFlag(index)">删除</button>
        </div>
      </div>
    </div>
  </section>
</template>
