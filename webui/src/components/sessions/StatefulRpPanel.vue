<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { RefreshCw } from "lucide-vue-next";
import { WorkbenchAreaHeader, WorkbenchButton, WorkbenchCard, WorkbenchDisclosure, WorkbenchEmptyState, WorkbenchKeyValueDetails } from "@workbench-kit/vue";
import SessionSnapshotsButton from "./SessionSnapshotsButton.vue";
import StatefulRpValue from "./StatefulRpValue.vue";
import { fieldLabel, simulationStateSchema, socialStateSchema, valueSummary } from "./statefulRpView";
import { sessionsApi } from "@/api/sessions";
import { useElementWidth } from "@/composables/useElementWidth";
import type { ActiveSession } from "@/stores/sessions";
import type { StatefulRpSessionState } from "@/api/types";

const props = defineProps<{ session: ActiveSession }>();
const state = ref<StatefulRpSessionState | null>(null);
const error = ref("");
const loading = ref(false);
const pane = ref<HTMLElement | null>(null);
const width = useElementWidth(pane);
const compact = computed(() => width.value > 0 && width.value < 640);
const expanded = reactive<Record<string, boolean>>({});
const allEvents = ref(false);
let sequence = 0;
const overview = computed(() => [
  { label: "游戏时间", value: state.value?.simulation.clock?.currentIso ?? "未指定" },
  { label: "时区", value: state.value?.simulation.clock?.timezone ?? "未指定" },
  { label: "地点", value: state.value?.simulation.scene?.location ?? "未指定" },
  { label: "心情", value: state.value?.social.currentMood ?? "未指定" }
]);
const cycle = computed(() => state.value?.simulation.body?.activePhysiology?.menstrualCycle);
const cycleOverview = computed(() => [
  { label: "当前状态", value: cycle.value?.active ? "进行中" : "当前未发生" },
  { label: "上次开始", value: cycle.value?.lastStartDate ?? "未指定" },
  { label: "本次结束", value: cycle.value?.currentEndDate ?? "未计算" },
  { label: "下次开始", value: cycle.value?.nextStartDate ?? "未计算" }
]);
const sections = computed(() => state.value ? [
  { key: "social", label: "社交", value: state.value.social, schema: socialStateSchema },
  ...Object.entries(simulationStateSchema.properties ?? {}).filter(([key]) => key !== "initialized").map(([key, schema]) => ({
    key, label: fieldLabel(key, schema), value: state.value!.simulation[key], schema
  }))
] : []);
const events = computed(() => [...(state.value?.events ?? [])].reverse().slice(0, allEvents.value ? undefined : 10));
async function refresh() {
  const seq = ++sequence;
  const id = props.session.id;
  loading.value = true;
  error.value = "";
  try {
    const detail = await sessionsApi.fetchDetail(id);
    if (seq !== sequence || id !== props.session.id) return;
    state.value = detail.modeState?.kind === "stateful_rp" ? detail.modeState.state : null;
  } catch (e) {
    if (seq === sequence && id === props.session.id) error.value = e instanceof Error ? e.message : "载入 RP 状态失败";
  } finally {
    if (seq === sequence && id === props.session.id) loading.value = false;
  }
}
watch(() => [props.session.id, props.session.modeId], () => {
  state.value = null;
  allEvents.value = false;
  Object.keys(expanded).forEach(key => delete expanded[key]);
  void refresh();
}, { immediate: true });
watch(() => [props.session.transcriptCount, props.session.mutationEpoch, props.session.phase.kind], () => {
  if (props.session.phase.kind === "idle") void refresh();
});
onBeforeUnmount(() => { sequence++; });
</script>

<template>
  <div ref="pane" class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <WorkbenchAreaHeader class="flex-wrap justify-between gap-2 px-3 py-1" :uppercase="false">
      <span class="text-small text-text-subtle">角色动态状态</span>
      <div class="flex shrink-0 items-center gap-1">
        <SessionSnapshotsButton :session-id="session.id" :session-generating="session.phase.kind !== 'idle'" @restored="refresh" />
        <WorkbenchButton variant="ghost" :icon="RefreshCw" :icon-size="12" :disabled="loading" :label="loading ? '加载中…' : '刷新'" title="重新加载 RP 状态" class="text-small" @click="refresh" />
      </div>
    </WorkbenchAreaHeader>
    <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
      <div class="flex min-w-0 flex-col gap-4" :aria-busy="loading">
        <WorkbenchCard v-if="error" role="alert" class="text-small text-danger">
          <p>{{ error }}</p>
          <p v-if="state" class="mt-1 text-text-subtle">当前显示上次成功加载的状态。</p>
          <WorkbenchButton variant="ghost" label="重试" :disabled="loading" @click="refresh" />
        </WorkbenchCard>
        <WorkbenchEmptyState v-if="loading && !state" message="正在加载 RP 状态…" class="py-6 text-small text-text-subtle" />
        <WorkbenchEmptyState v-else-if="!state && !error" message="当前会话暂无 RP 状态" class="py-6 text-small text-text-subtle" />
        <template v-if="state">
          <WorkbenchCard v-if="!state.initialized" title="尚未确认开局">
            <p class="text-small text-text-muted">请在聊天中完成当前配置阶段，使用 .confirm 保存；允许跳过不想填写的内容。下方展示当前已保存状态。</p>
          </WorkbenchCard>
          <WorkbenchCard title="当前概览">
            <WorkbenchKeyValueDetails :items="overview" :compact="compact" label-width="6rem">
              <template #label="{ item }"><span class="font-sans">{{ item.label }}</span></template>
              <template #value="{ item }"><span class="whitespace-pre-wrap wrap-break-word text-text-secondary">{{ item.value }}</span></template>
            </WorkbenchKeyValueDetails>
          </WorkbenchCard>
          <WorkbenchCard title="周期状态（自动计算）">
            <WorkbenchEmptyState v-if="!cycle" :centered="false" message="未配置或已关闭" class="text-small text-text-subtle" />
            <WorkbenchKeyValueDetails v-else :items="cycleOverview" :compact="compact" label-width="6rem">
              <template #label="{ item }"><span class="font-sans">{{ item.label }}</span></template>
              <template #value="{ item }"><span class="text-text-secondary">{{ item.value }}</span></template>
            </WorkbenchKeyValueDetails>
          </WorkbenchCard>
          <WorkbenchCard title="近期状态事件">
            <WorkbenchEmptyState v-if="!events.length" :centered="false" message="暂无状态事件" class="text-small text-text-subtle" />
            <ol v-else class="flex flex-col gap-2">
              <li v-for="event in events" :key="event.id" class="border-b border-border-subtle pb-2 text-small">
                <div class="text-text-subtle">{{ event.date || '未指定日期' }}</div>
                <p class="mt-1 whitespace-pre-wrap wrap-break-word text-text-secondary">{{ event.summary }}</p>
              </li>
            </ol>
            <WorkbenchButton v-if="state.events.length > 10" variant="ghost" :label="allEvents ? '收起较早事件' : `查看全部 ${state.events.length} 条事件`" class="mt-2 text-small" @click="allEvents = !allEvents" />
          </WorkbenchCard>
          <WorkbenchDisclosure v-for="section in sections" :key="section.key" :title="section.label" :summary="valueSummary(section.value)" :expanded="expanded[section.key] === true" max-body-height-class="max-h-none" @toggle="expanded[section.key] = !expanded[section.key]">
            <StatefulRpValue :value="section.value" :schema="section.schema" :compact="compact" />
          </WorkbenchDisclosure>
          <p class="text-small text-text-subtle">普通游玩和 # 场外指令可修改动态属性。固定设定可在 Data 的「三层角色档案」编辑，或使用 .config persona / social / embodiment；周期日期校正使用 .config state。</p>
        </template>
      </div>
    </div>
  </div>
</template>
