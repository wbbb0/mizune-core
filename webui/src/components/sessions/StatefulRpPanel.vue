<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RefreshCw, RotateCcw, Save, X } from "lucide-vue-next";
import { sessionsApi } from "@/api/sessions";
import type { SessionDetailResult, StatefulRpSessionState } from "@/api/types";
import type { ActiveSession } from "@/stores/sessions";
import { ApiError } from "@/api/client";
import ScenarioHostSnapshotDialogContent from "./ScenarioHostSnapshotDialogContent.vue";
import { WorkbenchAreaHeader, WorkbenchEmptyState, useWorkbenchWindows } from "@workbench-kit/vue";
import { createSessionWindowContext } from "./sessionWindowContext";

const props = defineProps<{
  session: ActiveSession;
}>();

const detail = ref<SessionDetailResult | null>(null);
const loading = ref(false);
const errorMessage = ref("");
const editing = ref(false);
const draftText = ref("");
const saving = ref(false);
const saveError = ref("");
const windows = useWorkbenchWindows();
const sessionGenerating = computed(() => (
  detail.value?.session.isGenerating === true
  || ["requesting_llm", "reasoning", "generating", "tool_calling", "delivering"].includes(props.session.phase.kind)
));
let requestSeq = 0;

const BODY_PART_LABELS: Record<string, string> = {
  head_neck: "头颈与面颊",
  chest: "胸乳与锁骨",
  waist_belly: "腰腹与后腰",
  groin_hips: "私处与臀胯",
  thighs_legs: "大腿与腿部",
  feet: "足部与脚踝"
};

const state = computed<StatefulRpSessionState | null>(() => (
  detail.value?.modeState?.kind === "stateful_rp" ? detail.value.modeState.state : null
));

function formatClock(iso?: string): string {
  if (!iso) return "";
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso.trim());
  return match ? `${match[1]} ${match[2]}` : iso;
}

const vitalsEntries = computed(() => {
  const v = state.value?.embodiment.vitals;
  if (!v) return [];
  return [
    { key: "stamina", label: "体力", value: v.stamina },
    { key: "energy", label: "精力", value: v.energy },
    { key: "hygiene", label: "清洁度", value: v.hygiene },
    { key: "hunger", label: "饥饿感", value: v.hunger },
    { key: "thirst", label: "口渴感", value: v.thirst },
    { key: "bladder", label: "便意/憋尿", value: v.bladder },
    { key: "intoxication", label: "醉意", value: v.intoxication },
    { key: "pain", label: "痛感", value: v.pain },
    { key: "soreness", label: "酸胀感", value: v.soreness }
  ];
});

const sortedPartSensations = computed(() => {
  const parts = state.value?.embodiment.partSensations;
  if (!parts) return [];
  return Object.entries(parts)
    .map(([key, data]) => ({
      key,
      label: BODY_PART_LABELS[key] ?? key,
      ...data
    }))
    .sort((left, right) => right.salience - left.salience);
});

const relationshipDimensions = computed(() => {
  const r = state.value?.relationship;
  if (!r) return [];
  return [
    { key: "intimacy", label: "亲密度", value: r.intimacy },
    { key: "trust", label: "信任度", value: r.trust },
    { key: "affection", label: "依恋度", value: r.affection },
    { key: "respect", label: "尊重度", value: r.respect },
    { key: "romanticTension", label: "暧昧张力", value: r.tension.romanticTension },
    { key: "unresolvedFriction", label: "未解心结", value: r.tension.unresolvedFriction },
    { key: "jealousy", label: "醋意", value: r.tension.jealousy }
  ];
});

const recentJournal = computed(() => (state.value?.journal ?? []).slice(-10).reverse());
const recentMaintenance = computed(() => (state.value?.maintenanceLog ?? []).slice(-8).reverse());

async function loadDetail(): Promise<void> {
  const seq = ++requestSeq;
  const sessionId = props.session.id;
  loading.value = true;
  errorMessage.value = "";
  try {
    const loaded = await sessionsApi.fetchDetail(sessionId);
    if (seq === requestSeq && props.session.id === sessionId) {
      detail.value = loaded;
    }
  } catch (error: unknown) {
    if (seq === requestSeq && props.session.id === sessionId) {
      errorMessage.value = error instanceof ApiError || error instanceof Error
        ? error.message
        : "载入沉浸状态 RP 失败";
    }
  } finally {
    if (seq === requestSeq && props.session.id === sessionId) {
      loading.value = false;
    }
  }
}

function startEditing(): void {
  if (!state.value) return;
  if (editing.value && !window.confirm("当前有未保存的编辑，重置为最新状态？")) {
    return;
  }
  draftText.value = JSON.stringify(state.value, null, 2);
  saveError.value = "";
  editing.value = true;
}

function cancelEditing(): void {
  editing.value = false;
  saveError.value = "";
}

async function saveEditing(): Promise<void> {
  if (!state.value) return;
  let parsed: StatefulRpSessionState;
  try {
    parsed = JSON.parse(draftText.value) as StatefulRpSessionState;
  } catch (error: unknown) {
    saveError.value = error instanceof Error ? error.message : "JSON 解析失败";
    return;
  }
  saving.value = true;
  saveError.value = "";
  try {
    const response = await sessionsApi.updateStatefulRpState(props.session.id, {
      state: parsed
    });
    detail.value = detail.value
      ? { ...detail.value, modeState: response.modeState }
      : detail.value;
    editing.value = false;
  } catch (error: unknown) {
    saveError.value = error instanceof ApiError || error instanceof Error
      ? error.message
      : "保存失败";
  } finally {
    saving.value = false;
  }
}

async function resetState(): Promise<void> {
  if (!window.confirm("确定要重置当前会话的沉浸状态 RP 数据吗？（聊天记录不会删除）")) {
    return;
  }
  loading.value = true;
  errorMessage.value = "";
  try {
    const response = await sessionsApi.resetStatefulRpState(props.session.id);
    detail.value = detail.value
      ? { ...detail.value, modeState: response.modeState }
      : detail.value;
    editing.value = false;
  } catch (error: unknown) {
    errorMessage.value = error instanceof ApiError || error instanceof Error
      ? error.message
      : "重置状态失败";
  } finally {
    loading.value = false;
  }
}

function openSnapshotsDialog(): void {
  void windows.openDialog({
    title: "存档 / 读档",
    description: "保存当前会话快照，或读取已有存档。",
    size: "lg",
    modal: true,
    context: createSessionWindowContext(props.session.id),
    footer: "close",
    blocks: [
      {
        kind: "component",
        component: ScenarioHostSnapshotDialogContent,
        props: {
          sessionId: props.session.id,
          sessionGenerating,
          onRestored: loadDetail
        }
      }
    ]
  });
}

watch(() => [props.session.id, props.session.modeId] as const, () => {
  detail.value = null;
  editing.value = false;
  void loadDetail();
}, { immediate: true });

watch(() => props.session.transcriptCount, () => {
  if (!editing.value) {
    void loadDetail();
  }
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <WorkbenchAreaHeader class="flex-wrap justify-between gap-2 px-3 py-1" :uppercase="false">
      <span class="min-w-0 text-small text-text-subtle">
        沉浸状态 RP
        <span v-if="state" class="ml-2 text-text-muted">
          {{ formatClock(state.clock.currentIso) }}（周{{ state.clock.dayOfWeek }} · {{ state.clock.timeOfDay }} · {{ state.world.weather }}） ·
          {{ state.initialized ? "已初始化" : "待开场初始化" }}
        </span>
      </span>
      <div class="flex shrink-0 items-center gap-1">
        <button
          class="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-small text-text-muted hover:text-text-primary"
          title="打开存档读档"
          @click="openSnapshotsDialog"
        >
          <Save :size="12" :stroke-width="2" />
          存档/读档
        </button>
        <button
          class="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-small text-text-muted hover:text-text-primary"
          :disabled="loading || !state"
          title="编辑原始 JSON"
          @click="startEditing"
        >
          <Save :size="12" :stroke-width="2" />
          编辑 JSON
        </button>
        <button
          class="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-small text-text-muted hover:text-danger"
          :disabled="loading || editing || !state"
          title="重置动态状态"
          @click="resetState"
        >
          <RotateCcw :size="12" :stroke-width="2" />
          重置
        </button>
        <button
          class="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-small text-text-muted hover:text-text-primary"
          :disabled="loading || editing"
          :title="editing ? '编辑中不可刷新，请先保存或取消' : '重新加载'"
          @click="loadDetail"
        >
          <RefreshCw :size="12" :stroke-width="2" :class="{ spin: loading }" />
          重新加载
        </button>
      </div>
    </WorkbenchAreaHeader>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div
        v-if="errorMessage"
        class="mb-4 rounded border border-[color-mix(in_srgb,var(--danger)_55%,transparent)] bg-surface-danger px-3 py-2 text-small text-danger"
      >
        {{ errorMessage }}
      </div>

      <div class="mb-4 rounded border border-border-subtle bg-surface-sidebar px-3 py-2 text-small text-text-subtle">
        提示：在聊天输入框中使用 <code class="font-mono text-text-secondary"># 指令</code> 发送导演/OOC 修订指令，使用 <code class="font-mono text-text-secondary">* 动作</code> 描写玩家动作或推进时间；点击右上角“存档/读档”可随时保存或恢复当前会话与状态快照。
      </div>

      <template v-if="editing">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div class="text-small text-text-subtle">直接编辑 `StatefulRpSessionState` JSON；保存前会执行 Zod Schema 与范围裁剪校验。</div>
          <div class="flex items-center gap-2">
            <button class="btn-ghost flex items-center gap-1 px-2 py-1 text-small" :disabled="saving" @click="cancelEditing">
              <X :size="12" /> 取消
            </button>
            <button class="btn btn-primary flex items-center gap-1 px-2 py-1 text-small" :disabled="saving" @click="saveEditing">
              <Save :size="12" /> {{ saving ? "保存中…" : "保存" }}
            </button>
          </div>
        </div>
        <div v-if="saveError" class="mb-3 rounded bg-surface-danger px-3 py-2 text-small text-danger">{{ saveError }}</div>
        <textarea
          v-model="draftText"
          class="h-[60vh] w-full resize-none rounded border border-border-subtle bg-surface-base p-3 font-mono text-small text-text-secondary outline-none focus:border-border-strong"
          spellcheck="false"
        />
      </template>

      <template v-else-if="state">
        <div class="grid gap-4 xl:grid-cols-2">
          <!-- 1. 时间、空间与当前场景 -->
          <section class="rounded border border-border-subtle bg-surface-base p-4">
            <h2 class="mb-3 text-ui font-semibold text-text-primary">时间与当前场景</h2>
            <div class="grid gap-2 text-small text-text-secondary">
              <div class="flex flex-wrap items-center gap-2">
                <span class="rounded bg-surface-raised px-2 py-0.5 font-medium">{{ formatClock(state.clock.currentIso) }}</span>
                <span class="rounded bg-surface-raised px-2 py-0.5 text-text-muted">周{{ state.clock.dayOfWeek }} · {{ state.clock.timeOfDay }} · {{ state.world.weather }}</span>
                <span class="rounded bg-surface-raised px-2 py-0.5 text-text-muted">活动：{{ state.clock.lastActivityKind }}</span>
              </div>
              <div>
                <span class="text-text-subtle">当前地点：</span>{{ state.world.currentLocation }}
                <span v-if="state.world.locationTags.length > 0" class="text-text-muted">（{{ state.world.locationTags.join(" / ") }}）</span>
              </div>
              <div>
                <span class="text-text-subtle">同处状态：</span>{{ state.world.isSeparated ? "异地分开" : "同处一地" }}
                <span v-if="state.world.presentNpcs.length > 0" class="ml-2 text-text-muted">在场：{{ state.world.presentNpcs.join("、") }}</span>
              </div>
              <div v-if="state.world.ambientPressure"><span class="text-text-subtle">周边环境压力：</span>{{ state.world.ambientPressure }}</div>
              <div v-if="state.world.lastOffScreenSummary" class="rounded bg-surface-raised p-2 text-text-secondary">
                <span class="text-text-subtle">最近独处经历：</span>{{ state.world.lastOffScreenSummary }}
              </div>
              <div v-if="state.world.schedule.length > 0" class="mt-2 space-y-1">
                <div class="text-text-subtle">日程表</div>
                <div
                  v-for="entry in state.world.schedule"
                  :key="entry.id"
                  class="flex items-center justify-between gap-2 rounded bg-surface-raised px-2 py-1"
                >
                  <span>{{ formatClock(entry.startIso) }} ~ {{ formatClock(entry.endIso) }} · {{ entry.title }}@{{ entry.location }}</span>
                  <span class="text-text-subtle">{{ entry.status }}</span>
                </div>
              </div>
            </div>
          </section>

          <!-- 2. 生理、周期与亲密反应 -->
          <section class="rounded border border-border-subtle bg-surface-base p-4">
            <h2 class="mb-3 text-ui font-semibold text-text-primary">身体状况与亲密生理</h2>
            <div class="mb-2 space-y-1 text-small text-text-secondary">
              <div><span class="text-text-subtle">妆容与神态：</span>{{ state.embodiment.appearance.makeupAndHair }} ｜ {{ state.embodiment.appearance.postureAndDemeanor }}</div>
              <div v-if="state.embodiment.appearance.observable.length > 0">
                <span class="text-text-subtle">外显生理线索：</span>{{ state.embodiment.appearance.observable.join("、") }}
              </div>
              <div>
                <span class="text-text-subtle">生理周期：</span>第 {{ state.embodiment.cycle.dayOfCycle }}/{{ state.embodiment.cycle.cycleLength }} 天（{{ state.embodiment.cycle.phase }}，不适 {{ state.embodiment.cycle.symptomSeverity }}）
                <span class="ml-2 text-text-muted">体温:{{ state.embodiment.vitals.temperature }} / 心率:{{ state.embodiment.vitals.heartRate }}</span>
              </div>
            </div>
            <div class="mb-3 space-y-1.5">
              <div v-for="item in vitalsEntries" :key="item.key" class="flex items-center gap-2 text-small">
                <span class="w-20 shrink-0 text-text-subtle">{{ item.label }}</span>
                <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-surface-raised">
                  <div class="h-full rounded bg-accent" :style="{ width: `${Math.max(0, Math.min(100, item.value))}%` }" />
                </div>
                <span class="w-8 text-right text-text-muted">{{ Math.round(item.value) }}</span>
              </div>
            </div>
            <div class="rounded bg-surface-raised p-2.5 text-small text-text-secondary">
              <div class="mb-1 font-medium text-text-primary">私密生理反应</div>
              <div class="flex flex-wrap gap-3 text-text-muted">
                <span>润滑度 {{ state.embodiment.intimateState.lubrication }}/100</span>
                <span>肌肉紧绷 {{ state.embodiment.intimateState.muscleTension }}/100</span>
              </div>
              <div v-if="state.embodiment.intimateState.lingeringSimulation" class="mt-1 text-text-subtle">
                余韵/持续刺激：{{ state.embodiment.intimateState.lingeringSimulation }}
              </div>
              <div v-if="state.embodiment.intimateState.secretionNote" class="mt-1 text-text-subtle">
                分泌物与痕迹：{{ state.embodiment.intimateState.secretionNote }}
              </div>
            </div>
          </section>

          <!-- 3. 服饰穿戴、私密道具与分部位感受 -->
          <section class="rounded border border-border-subtle bg-surface-base p-4">
            <h2 class="mb-3 text-ui font-semibold text-text-primary">服饰穿戴与身体分部位感受</h2>
            <div class="mb-2 text-small text-text-secondary">
              <span class="text-text-subtle">穿搭预设：</span>{{ state.embodiment.outfit.presetName }}
              <div class="mt-1 text-text-subtle">{{ state.embodiment.outfit.overallImpact }}</div>
            </div>
            <div class="mb-3 space-y-1.5">
              <div
                v-for="item in state.embodiment.outfit.items"
                :key="item.id"
                class="rounded bg-surface-raised px-2.5 py-1.5 text-small text-text-secondary"
              >
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-medium text-text-primary">[{{ item.layer }}/{{ item.slot }}] {{ item.name }}</span>
                  <span class="text-text-muted">已穿 {{ item.wornMinutes }}m · 透气 {{ item.breathability }} · 舒适 {{ item.comfort }}</span>
                </div>
                <div class="mt-0.5 flex flex-wrap gap-2 text-text-muted">
                  <span v-if="item.material">材质:{{ item.material }}({{ item.fit }})</span>
                  <span v-if="item.displacement !== 'normal'">状态:{{ item.displacement }}</span>
                  <span v-if="item.wetness > 0">汗湿:{{ item.wetness }}</span>
                  <span v-if="item.secretionStain > 0">分泌物:{{ item.secretionStain }}</span>
                  <span v-if="item.odorIntensity > 0 || item.odorNote">气味:{{ item.odorIntensity }} {{ item.odorNote }}</span>
                  <span v-if="item.conditionNote">{{ item.conditionNote }}</span>
                </div>
              </div>
              <div
                v-for="gear in state.embodiment.outfit.intimateGear"
                :key="gear.id"
                class="rounded border border-border-subtle bg-surface-raised px-2.5 py-1.5 text-small text-text-secondary"
              >
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-medium text-text-primary">[私密道具] {{ gear.name }}（{{ gear.position }}）</span>
                  <span class="text-text-muted">强度 {{ gear.intensity }} · 已戴 {{ gear.wornMinutes }}m · {{ gear.concealed ? "隐蔽" : "外露" }}</span>
                </div>
                <div v-if="gear.effectNote" class="mt-0.5 text-text-subtle">{{ gear.effectNote }}</div>
              </div>
            </div>

            <div class="space-y-1.5">
              <div class="text-small font-medium text-text-primary">身体分部位感官（按显著度排序）</div>
              <div
                v-for="part in sortedPartSensations"
                :key="part.key"
                class="rounded bg-surface-raised px-2.5 py-1.5 text-small text-text-secondary"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="font-medium text-text-primary">{{ part.label }}</span>
                  <span class="text-text-muted">敏感 {{ part.sensitivity }} · 显著 {{ part.salience }}</span>
                </div>
                <div v-if="part.sensation" class="mt-0.5">{{ part.sensation }}</div>
                <div v-if="part.appearanceNote || part.scentNote" class="mt-0.5 text-text-muted">
                  <span v-if="part.appearanceNote">外观：{{ part.appearanceNote }}</span>
                  <span v-if="part.scentNote" class="ml-2">气味：{{ part.scentNote }}</span>
                </div>
              </div>
            </div>
          </section>

          <!-- 4. 心理反差、微意图与关系边界 -->
          <section class="rounded border border-border-subtle bg-surface-base p-4">
            <h2 class="mb-3 text-ui font-semibold text-text-primary">心理反差与关系演化</h2>
            <div class="mb-3 space-y-1.5 rounded bg-surface-raised p-2.5 text-small text-text-secondary">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-medium text-text-primary">
                  情绪：{{ state.mind.emotion.primary }}{{ state.mind.emotion.secondary ? ` / ${state.mind.emotion.secondary}` : "" }}
                </span>
                <span class="text-text-muted">
                  效价 {{ state.mind.emotion.valence }} · 唤醒 {{ state.mind.emotion.arousal }} · 自控 {{ state.mind.emotion.selfControl }}
                </span>
              </div>
              <div><span class="text-text-subtle">外在伪装：</span>{{ state.mind.surfaceVsInner.surfaceDemeanor }}</div>
              <div><span class="text-text-subtle">内心独白：</span>{{ state.mind.surfaceVsInner.innerMonologue }}（反差张力 {{ state.mind.surfaceVsInner.tension }}）</div>
              <div class="flex flex-wrap gap-2 pt-1 text-text-muted">
                <span>情欲 {{ state.mind.desire.arousal }}</span>
                <span>渴望 {{ state.mind.desire.longing }}</span>
                <span>羞耻 {{ state.mind.desire.shame }}</span>
                <span>煎熬 {{ state.mind.desire.frustration }}</span>
                <span v-if="state.mind.desire.focus">焦点：{{ state.mind.desire.focus }}</span>
              </div>
            </div>

            <div v-if="state.mind.intrusiveThoughts.length > 0" class="mb-3 space-y-1 text-small">
              <div class="text-text-subtle">侵入性杂念</div>
              <div v-for="(thought, idx) in state.mind.intrusiveThoughts" :key="idx" class="rounded bg-surface-raised px-2 py-1 text-text-secondary">
                {{ thought }}
              </div>
            </div>

            <div v-if="state.mind.intentions.length > 0" class="mb-3 space-y-1 text-small">
              <div class="text-text-subtle">短期微意图</div>
              <div v-for="intent in state.mind.intentions" :key="intent.id" class="rounded bg-surface-raised px-2 py-1 text-text-secondary">
                [P{{ intent.priority }}/{{ intent.status }}] {{ intent.goal }}
                <span v-if="intent.reason" class="text-text-muted">（{{ intent.reason }}）</span>
              </div>
            </div>

            <div class="mb-2 text-small text-text-secondary">
              <span class="text-text-subtle">关系阶段：</span>{{ state.relationship.stage }}（主导倾向 {{ state.relationship.dominanceBalance }}）
              <div class="text-text-muted">边界：{{ state.relationship.boundaries.comfortLevel }}</div>
              <div v-if="state.relationship.tension.recentAfterglow" class="text-text-muted">近期余韵：{{ state.relationship.tension.recentAfterglow }}</div>
            </div>
            <div class="space-y-1.5">
              <div v-for="dim in relationshipDimensions" :key="dim.key" class="flex items-center gap-2 text-small">
                <span class="w-20 shrink-0 text-text-subtle">{{ dim.label }}</span>
                <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-surface-raised">
                  <div class="h-full rounded bg-accent" :style="{ width: `${Math.max(0, Math.min(100, dim.value))}%` }" />
                </div>
                <span class="w-8 text-right text-text-muted">{{ Math.round(dim.value) }}</span>
              </div>
            </div>
          </section>
        </div>

        <!-- 5. 近期日志与后置维护记录 -->
        <div class="mt-4 grid gap-4 xl:grid-cols-2">
          <section class="rounded border border-border-subtle bg-surface-base p-4">
            <h2 class="mb-2 text-ui font-semibold text-text-primary">近期状态日志</h2>
            <div v-if="recentJournal.length === 0" class="text-small text-text-muted">暂无状态日志</div>
            <div v-else class="space-y-1.5 text-small">
              <div v-for="entry in recentJournal" :key="entry.id" class="rounded bg-surface-raised px-2.5 py-1.5 text-text-secondary">
                <span class="text-text-muted">[{{ formatClock(entry.clockIso) }} / {{ entry.category }}]</span> {{ entry.summary }}
              </div>
            </div>
          </section>

          <section class="rounded border border-border-subtle bg-surface-base p-4">
            <h2 class="mb-2 text-ui font-semibold text-text-primary">后置静默维护记录</h2>
            <div v-if="recentMaintenance.length === 0" class="text-small text-text-muted">暂无后置维护记录</div>
            <div v-else class="space-y-1.5 text-small">
              <div v-for="log in recentMaintenance" :key="log.id" class="rounded bg-surface-raised px-2.5 py-1.5 text-text-secondary">
                <div class="flex flex-wrap items-center justify-between gap-2 text-text-muted">
                  <span>{{ formatClock(log.clockIso) }}（+{{ log.elapsedMinutes }}m）</span>
                  <span>{{ log.passesRun.join(" → ") }}</span>
                </div>
                <div class="mt-0.5">{{ log.summary }}</div>
              </div>
            </div>
          </section>
        </div>
      </template>

      <WorkbenchEmptyState
        v-else
        title="暂无沉浸状态 RP 数据"
        description="发送首条消息或点击重新加载以初始化状态。"
      />
    </div>
  </div>
</template>
