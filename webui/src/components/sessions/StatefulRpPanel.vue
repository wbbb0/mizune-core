<script setup lang="ts">
import { computed, ref, watch } from "vue";
import SessionSnapshotsButton from "./SessionSnapshotsButton.vue";
import { sessionsApi } from "@/api/sessions";
import type { ActiveSession } from "@/stores/sessions";
import type { StatefulRpSessionState } from "@/api/types";

const props = defineProps<{ session: ActiveSession }>();
const state = ref<StatefulRpSessionState | null>(null);
const error = ref("");
const loading = ref(false);
let sequence = 0;
const cycle = computed(() => state.value?.simulation.body.activePhysiology.menstrualCycle);
async function refresh() {
  const seq = ++sequence, id = props.session.id;
  loading.value = true;
  try {
    const detail = await sessionsApi.fetchDetail(id);
    if (seq !== sequence || id !== props.session.id) return;
    state.value = detail.modeState?.kind === "stateful_rp" ? detail.modeState.state : null;
    error.value = "";
  } catch (e) { if (seq === sequence) error.value = e instanceof Error ? e.message : String(e); }
  finally { if (seq === sequence) loading.value = false; }
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
watch(() => props.session.id, () => { state.value = null; void refresh(); }, { immediate: true });
watch(() => [props.session.transcriptCount, props.session.mutationEpoch, props.session.phase.kind], () => { if (props.session.phase.kind === "idle") void refresh(); });
</script>

<template>
  <section class="flex h-full flex-col gap-4 overflow-auto p-4 text-sm">
    <div class="flex items-center justify-between">
      <h2 class="font-semibold">角色动态状态</h2>
      <SessionSnapshotsButton :session-id="session.id" :session-generating="session.phase.kind !== 'idle'" @restored="refresh" />
      <button class="rounded border px-3 py-1 disabled:opacity-50" :disabled="loading" @click="refresh">刷新</button>
    </div>
    <p v-if="error" class="text-red-500">{{ error }}</p>
    <p v-if="!state?.initialized" class="rounded border p-3">尚未确认开局。请在聊天中完成当前配置阶段，使用 .confirm 保存；允许跳过不想填写的内容。</p>
    <template v-if="state">
      <div class="rounded border p-3">
        <div>游戏时间：{{ state.simulation.clock?.currentIso ?? '未指定' }}（{{ state.simulation.clock?.timezone ?? '未指定时区' }}）</div>
        <div>地点：{{ state.simulation.scene.location ?? '未指定' }}</div>
        <div>心情：{{ state.social.currentMood ?? '未指定' }}</div>
      </div>
      <div class="rounded border p-3">
        <h3 class="mb-2 font-medium">周期状态（代码维护）</h3>
        <template v-if="cycle">
          <div>当前：{{ cycle.active ? '进行中' : '未发生' }}</div>
          <div>上次开始：{{ cycle.lastStartDate ?? '未指定' }}</div>
          <div>本次结束：{{ cycle.currentEndDate ?? '待计算' }}</div>
          <div>下次开始：{{ cycle.nextStartDate ?? '参数不完整，暂停计算' }}</div>
        </template>
        <p v-else>未配置或已关闭。</p>
      </div>
      <details v-for="(value, key) in { 社交: state.social, 身体: state.simulation.body, 心理: state.simulation.mind, 衣柜: state.simulation.wardrobe, 日程: state.simulation.schedule }" :key="key" class="rounded border p-3">
        <summary class="cursor-pointer font-medium">{{ key }}</summary>
        <pre class="mt-2 whitespace-pre-wrap break-words text-xs">{{ pretty(value) }}</pre>
      </details>
      <div class="rounded border p-3">
        <h3 class="mb-2 font-medium">近期状态事件</h3>
        <p v-if="!state.events.length">暂无。</p>
        <p v-for="event in state.events.slice(-10).reverse()" :key="event.id">{{ event.date }} · {{ event.summary }}</p>
      </div>
    </template>
    <p class="text-xs opacity-70">普通游玩和 # 场外指令可修改动态属性。固定设定使用 .config persona / social / embodiment；周期日期校正使用 .config state。</p>
  </section>
</template>
