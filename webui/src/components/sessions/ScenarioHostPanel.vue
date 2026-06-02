<script setup lang="ts">
import { ref, watch } from "vue";
import { RefreshCw } from "lucide-vue-next";
import { sessionsApi } from "@/api/sessions";
import type { ScenarioHostSessionState, SessionDetailResult } from "@/api/types";
import type { ActiveSession } from "@/stores/sessions";
import { ApiError } from "@/api/client";
import ScenarioHostStateEditor from "./ScenarioHostStateEditor.vue";
import { WorkbenchAreaHeader, WorkbenchEmptyState } from "@workbench-kit/vue";

const props = defineProps<{
  session: ActiveSession;
}>();

const detail = ref<SessionDetailResult | null>(null);
const loading = ref(false);
const errorMessage = ref("");
let detailRequestSeq = 0;

watch(() => [props.session.id, props.session.modeId] as const, () => {
  detail.value = null;
  void loadDetail();
}, { immediate: true });

async function loadDetail() {
  const requestSeq = ++detailRequestSeq;
  const sessionId = props.session.id;
  loading.value = true;
  errorMessage.value = "";
  try {
    const loaded = await sessionsApi.fetchDetail(sessionId);
    if (requestSeq === detailRequestSeq && props.session.id === sessionId) {
      detail.value = loaded;
    }
  } catch (error: unknown) {
    if (requestSeq === detailRequestSeq && props.session.id === sessionId) {
      errorMessage.value = error instanceof ApiError || error instanceof Error
        ? error.message
        : "载入 Scenario 状态失败";
    }
  } finally {
    if (requestSeq === detailRequestSeq && props.session.id === sessionId) {
      loading.value = false;
    }
  }
}

function onScenarioHostSaved(state: ScenarioHostSessionState) {
  if (!detail.value) {
    return;
  }
  detail.value = {
    ...detail.value,
    modeState: {
      kind: "scenario_host",
      state
    }
  };
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <WorkbenchAreaHeader class="flex-wrap justify-between gap-2 px-3 py-1" :uppercase="false">
      <span class="min-w-0 text-small text-text-subtle">当前会话 Scenario 数据</span>
      <button
        class="btn-ghost flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-small text-text-muted hover:text-text-primary"
        :disabled="loading"
        title="重新加载 Scenario 状态"
        @click="loadDetail"
      >
        <RefreshCw :size="12" :stroke-width="2" :class="{ spin: loading }" />
        重新加载
      </button>
    </WorkbenchAreaHeader>

    <div
      v-if="errorMessage"
      class="m-4 rounded border border-[color-mix(in_srgb,var(--danger)_55%,transparent)] bg-surface-danger px-3 py-2 text-small text-danger"
    >
      {{ errorMessage }}
    </div>

    <ScenarioHostStateEditor
      v-if="detail?.modeState?.kind === 'scenario_host'"
      :session-id="session.id"
      :state="detail.modeState.state"
      @saved="onScenarioHostSaved"
    />

    <WorkbenchEmptyState
      v-else
      class="px-6 py-6 text-small text-text-subtle"
      :message="loading ? '加载中…' : '当前会话不是 Scenario 模式'"
    />
  </div>
</template>
