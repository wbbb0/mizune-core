<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RefreshCw } from "lucide-vue-next";
import { ApiError } from "@/api/client";
import { sessionsApi } from "@/api/sessions";
import type { SessionSettings, SessionSettingsResult } from "@/api/types";
import type { ActiveSession } from "@/stores/sessions";
import { WorkbenchAreaHeader } from "@workbench-kit/vue";
import SessionPacingControl from "./SessionPacingControl.vue";
import SessionToolsetBoundaryControl from "./SessionToolsetBoundaryControl.vue";

const props = defineProps<{
  session: ActiveSession;
}>();

const loaded = ref<SessionSettingsResult | null>(null);
const draft = ref<SessionSettings | null>(null);
const loading = ref(false);
const saving = ref(false);
const errorMessage = ref("");
let requestSeq = 0;

const dirty = computed(() => loaded.value != null
  && draft.value != null
  && JSON.stringify(loaded.value.settings) !== JSON.stringify(draft.value));

watch(() => [props.session.id, props.session.modeId] as const, () => {
  saving.value = false;
  loaded.value = null;
  draft.value = null;
  void loadSettings();
}, { immediate: true });

async function loadSettings(): Promise<void> {
  const sessionId = props.session.id;
  const seq = ++requestSeq;
  loading.value = true;
  errorMessage.value = "";
  try {
    const result = await sessionsApi.fetchSettings(sessionId);
    if (seq === requestSeq && props.session.id === sessionId) {
      loaded.value = result;
      draft.value = cloneSessionSettings(result.settings);
    }
  } catch (error: unknown) {
    if (seq === requestSeq && props.session.id === sessionId) {
      errorMessage.value = formatError(error, "载入会话设置失败");
    }
  } finally {
    if (seq === requestSeq && props.session.id === sessionId) {
      loading.value = false;
    }
  }
}

async function saveSettings(): Promise<void> {
  if (!draft.value || saving.value || !dirty.value) {
    return;
  }
  const sessionId = props.session.id;
  const seq = ++requestSeq;
  saving.value = true;
  errorMessage.value = "";
  try {
    const result = await sessionsApi.updateSettings(sessionId, cloneSessionSettings(draft.value));
    if (seq === requestSeq && props.session.id === sessionId) {
      loaded.value = result;
      draft.value = cloneSessionSettings(result.settings);
    }
  } catch (error: unknown) {
    if (seq === requestSeq && props.session.id === sessionId) {
      errorMessage.value = formatError(error, "保存会话设置失败");
    }
  } finally {
    if (seq === requestSeq && props.session.id === sessionId) {
      saving.value = false;
    }
  }
}

function resetDraft(): void {
  if (loaded.value) {
    draft.value = cloneSessionSettings(loaded.value.settings);
  }
  errorMessage.value = "";
}

function formatError(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

function cloneSessionSettings(settings: SessionSettings): SessionSettings {
  return {
    pacingPreferences: {
      inputDebounce: { ...settings.pacingPreferences.inputDebounce },
      oneBotOutbound: settings.pacingPreferences.oneBotOutbound,
      toolLoopOutput: settings.pacingPreferences.toolLoopOutput
    },
    toolsetPreferences: {
      overrides: { ...settings.toolsetPreferences.overrides }
    }
  };
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <WorkbenchAreaHeader class="flex-wrap justify-between gap-2 px-3 py-1" :uppercase="false">
      <span class="min-w-0 text-small text-text-subtle">配置当前会话的运行边界与回复节奏</span>
      <div class="flex shrink-0 items-center gap-2">
        <button
          class="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-small text-text-muted hover:text-text-primary"
          type="button"
          :disabled="loading || saving"
          title="重新加载会话设置"
          @click="loadSettings"
        >
          <RefreshCw :size="12" :stroke-width="2" :class="{ spin: loading }" />
          重新加载
        </button>
        <button class="btn-ghost px-2 py-1 text-small" type="button" :disabled="!dirty || saving" @click="resetDraft">撤销修改</button>
        <button class="btn btn-primary px-3 py-1 text-small" type="button" :disabled="!dirty || saving" @click="saveSettings">
          {{ saving ? '保存中…' : '保存设置' }}
        </button>
      </div>
    </WorkbenchAreaHeader>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div class="mx-auto flex max-w-4xl flex-col gap-4">
        <div
          v-if="errorMessage"
          class="rounded border border-[color-mix(in_srgb,var(--danger)_55%,transparent)] bg-surface-danger px-3 py-2 text-small text-danger"
        >
          {{ errorMessage }}
        </div>
        <div v-if="loading && !draft" class="py-8 text-center text-small text-text-subtle">载入设置中…</div>
        <template v-else-if="draft && loaded">
          <SessionToolsetBoundaryControl
            v-model="draft.toolsetPreferences"
            :options="loaded.toolsetOptions"
            :disabled="saving"
          />
          <SessionPacingControl
            v-model="draft.pacingPreferences"
            :source="session.source"
            :disabled="saving"
          />
        </template>
      </div>
    </div>
  </div>
</template>
