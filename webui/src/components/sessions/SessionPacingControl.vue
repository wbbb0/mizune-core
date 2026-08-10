<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { sessionsApi } from "@/api/sessions";
import type { SessionPacingPreferences } from "@/api/types";
import { ApiError } from "@/api/client";
import { WorkbenchDisclosure } from "@workbench-kit/vue";

const props = defineProps<{
  sessionId: string;
  source: "onebot" | "web";
  preferences: SessionPacingPreferences | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  updated: [preferences: SessionPacingPreferences];
}>();

const expanded = ref(false);
const saving = ref(false);
const errorMessage = ref("");
let saveRequestSeq = 0;

watch(() => props.sessionId, () => {
  saveRequestSeq += 1;
  saving.value = false;
  errorMessage.value = "";
});
const effectivePreferences = computed<SessionPacingPreferences>(() => props.preferences ?? (
  props.source === "web"
    ? { inputDebounce: { mode: "immediate" }, oneBotOutbound: "immediate" }
    : { inputDebounce: { mode: "adaptive" }, oneBotOutbound: "humanized" }
));
const fixedDebounceSeconds = computed(() => effectivePreferences.value.inputDebounce.mode === "fixed"
  ? effectivePreferences.value.inputDebounce.delayMs / 1000
  : 5);
const summary = computed(() => {
  if (saving.value) {
    return "保存中…";
  }
  if (
    effectivePreferences.value.inputDebounce.mode === "immediate"
    && effectivePreferences.value.oneBotOutbound === "immediate"
  ) {
    return "即时";
  }
  if (
    effectivePreferences.value.inputDebounce.mode === "adaptive"
    && effectivePreferences.value.oneBotOutbound === "humanized"
  ) {
    return "默认";
  }
  return "自定义";
});

async function save(preferences: SessionPacingPreferences) {
  if (saving.value || props.disabled || props.preferences == null) {
    return;
  }
  const sessionId = props.sessionId;
  const requestSeq = ++saveRequestSeq;
  saving.value = true;
  errorMessage.value = "";
  try {
    const result = await sessionsApi.updatePacing(sessionId, preferences);
    if (requestSeq === saveRequestSeq && props.sessionId === sessionId) {
      emit("updated", result.pacingPreferences);
    }
  } catch (error: unknown) {
    if (requestSeq === saveRequestSeq && props.sessionId === sessionId) {
      errorMessage.value = error instanceof ApiError || error instanceof Error
        ? error.message
        : "保存会话回复节奏失败";
    }
  } finally {
    if (requestSeq === saveRequestSeq) {
      saving.value = false;
    }
  }
}

function updateInputDebounceMode(event: Event) {
  const mode = (event.target as HTMLSelectElement).value;
  const inputDebounce: SessionPacingPreferences["inputDebounce"] = mode === "fixed"
    ? { mode: "fixed", delayMs: 5_000 }
    : mode === "immediate"
      ? { mode: "immediate" }
      : { mode: "adaptive" };
  void save({ ...effectivePreferences.value, inputDebounce });
}

function updateFixedDebounceSeconds(event: Event) {
  const raw = Number((event.target as HTMLInputElement).value);
  const seconds = Number.isFinite(raw) ? Math.min(120, Math.max(0, raw)) : 5;
  void save({
    ...effectivePreferences.value,
    inputDebounce: { mode: "fixed", delayMs: Math.round(seconds * 1000) }
  });
}

function updateOneBotOutboundPacing(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  void save({
    ...effectivePreferences.value,
    oneBotOutbound: enabled ? "humanized" : "immediate"
  });
}
</script>

<template>
  <WorkbenchDisclosure
    :expanded="expanded"
    collapsed-title="会话回复节奏"
    expanded-title="会话回复节奏"
    :summary="summary"
    @toggle="expanded = !expanded"
  >
    <div class="flex flex-col gap-4">
      <div
        v-if="errorMessage"
        class="rounded border border-[color-mix(in_srgb,var(--danger)_55%,transparent)] bg-surface-danger px-3 py-2 text-small text-danger"
      >
        {{ errorMessage }}
      </div>
      <label class="grid gap-1.5 text-small text-text-secondary">
        <span>用户消息聚合等待</span>
        <select
          class="input-base"
          :value="effectivePreferences.inputDebounce.mode"
          :disabled="disabled || saving || preferences == null"
          @change="updateInputDebounceMode"
        >
          <option value="adaptive">全局自适应</option>
          <option value="immediate">立即处理</option>
          <option value="fixed">固定等待</option>
        </select>
      </label>
      <label
        v-if="effectivePreferences.inputDebounce.mode === 'fixed'"
        class="grid gap-1.5 text-small text-text-secondary"
      >
        <span>固定等待秒数</span>
        <input
          class="input-base"
          type="number"
          min="0"
          max="120"
          step="0.5"
          :value="fixedDebounceSeconds"
          :disabled="disabled || saving || preferences == null"
          @change="updateFixedDebounceSeconds"
        />
      </label>
      <label class="flex items-start justify-between gap-4 rounded-lg border border-border-default bg-surface-sidebar px-3 py-2.5">
        <span class="min-w-0">
          <span class="block text-small text-text-secondary">OneBot 回复模拟输入延迟</span>
          <span class="mt-0.5 block text-small text-text-subtle">仅影响模型回复的 OneBot 投递；WebUI 回复始终即时。</span>
        </span>
        <input
          class="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
          type="checkbox"
          :checked="effectivePreferences.oneBotOutbound === 'humanized'"
          :disabled="disabled || saving || preferences == null || source === 'web'"
          @change="updateOneBotOutboundPacing"
        />
      </label>
      <div class="text-small leading-5 text-text-subtle">
        修改对下一次调度生效；已经开始等待的消息不会被重新计时。Web 会话默认立即处理并关闭 OneBot 延迟。
      </div>
    </div>
  </WorkbenchDisclosure>
</template>
