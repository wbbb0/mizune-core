<script setup lang="ts">
import { computed } from "vue";
import type { SessionPacingPreferences } from "@/api/types";

const props = defineProps<{
  source: "onebot" | "web";
  modelValue: SessionPacingPreferences;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [preferences: SessionPacingPreferences];
}>();

const fixedDebounceSeconds = computed(() => props.modelValue.inputDebounce.mode === "fixed"
  ? props.modelValue.inputDebounce.delayMs / 1000
  : 5);

function updateInputDebounceMode(event: Event) {
  const mode = (event.target as HTMLSelectElement).value;
  const inputDebounce: SessionPacingPreferences["inputDebounce"] = mode === "fixed"
    ? { mode: "fixed", delayMs: 5_000 }
    : mode === "immediate"
      ? { mode: "immediate" }
      : { mode: "adaptive" };
  emit("update:modelValue", { ...props.modelValue, inputDebounce });
}

function updateFixedDebounceSeconds(event: Event) {
  const raw = Number((event.target as HTMLInputElement).value);
  const seconds = Number.isFinite(raw) ? Math.min(120, Math.max(0, raw)) : 5;
  emit("update:modelValue", {
    ...props.modelValue,
    inputDebounce: { mode: "fixed", delayMs: Math.round(seconds * 1000) }
  });
}

function updateOneBotOutboundPacing(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  emit("update:modelValue", {
    ...props.modelValue,
    oneBotOutbound: enabled ? "humanized" : "immediate"
  });
}
</script>

<template>
  <section class="rounded-lg border border-border-default bg-surface-panel p-4">
    <div class="mb-4">
      <h3 class="text-ui font-medium text-text-primary">会话回复节奏</h3>
      <p class="mt-1 text-small leading-5 text-text-subtle">控制用户消息进入调度前的聚合等待，以及 OneBot 回复的模拟输入节奏。</p>
    </div>
    <div class="flex flex-col gap-4">
      <label class="grid gap-1.5 text-small text-text-secondary">
        <span>用户消息聚合等待</span>
        <select
          class="input-base"
          :value="modelValue.inputDebounce.mode"
          :disabled="disabled"
          @change="updateInputDebounceMode"
        >
          <option value="adaptive">全局自适应</option>
          <option value="immediate">立即处理</option>
          <option value="fixed">固定等待</option>
        </select>
      </label>
      <label
        v-if="modelValue.inputDebounce.mode === 'fixed'"
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
          :disabled="disabled"
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
          :checked="modelValue.oneBotOutbound === 'humanized'"
          :disabled="disabled || source === 'web'"
          @change="updateOneBotOutboundPacing"
        />
      </label>
      <div class="text-small leading-5 text-text-subtle">
        修改对下一次调度生效；已经开始等待的消息不会被重新计时。Web 会话默认立即处理并关闭 OneBot 延迟。
      </div>
    </div>
  </section>
</template>
