<script setup lang="ts">
import { computed, ref } from "vue";
import type { SessionToolsetOption, SessionToolsetPreferences } from "@/api/types";

const props = defineProps<{
  options: SessionToolsetOption[];
  modelValue: SessionToolsetPreferences;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [preferences: SessionToolsetPreferences];
}>();

const query = ref("");
const filteredOptions = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  if (!keyword) {
    return props.options;
  }
  return props.options.filter((option) => [
    option.title,
    option.description,
    option.id,
    ...option.toolNames
  ].some((value) => value.toLocaleLowerCase().includes(keyword)));
});
const enabledCount = computed(() => props.options.filter(isEnabled).length);

function isEnabled(option: SessionToolsetOption): boolean {
  const override = props.modelValue.overrides[option.id];
  return override == null ? option.defaultEnabled : override === "enabled";
}

function toggleOption(option: SessionToolsetOption, event: Event): void {
  emit("update:modelValue", withEffectiveValueFor(
    props.modelValue,
    option,
    (event.target as HTMLInputElement).checked
  ));
}

function setAll(enabled: boolean): void {
  let next = props.modelValue;
  for (const option of props.options) {
    next = withEffectiveValueFor(next, option, enabled);
  }
  emit("update:modelValue", next);
}

function restoreDefaults(): void {
  const optionIds = new Set(props.options.map((option) => option.id));
  emit("update:modelValue", {
    overrides: Object.fromEntries(
      Object.entries(props.modelValue.overrides).filter(([id]) => !optionIds.has(id))
    )
  });
}

function withEffectiveValueFor(
  preferences: SessionToolsetPreferences,
  option: SessionToolsetOption,
  enabled: boolean
): SessionToolsetPreferences {
  const overrides = { ...preferences.overrides };
  if (enabled === option.defaultEnabled) {
    delete overrides[option.id];
  } else {
    overrides[option.id] = enabled ? "enabled" : "disabled";
  }
  return { overrides };
}
</script>

<template>
  <section class="rounded-lg border border-border-default bg-surface-panel p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-ui font-medium text-text-primary">模型可用工具边界</h3>
        <p class="mt-1 max-w-3xl text-small leading-5 text-text-subtle">
          限制 Planner 的候选工具集，以及模型本轮最终可见的业务工具范围。启用只代表允许被选择，不会强制模型使用，也不会绕过身份、模型能力或系统配置限制；工具集查询与申请两个管理元工具始终保留。
        </p>
      </div>
      <span class="badge-pill shrink-0 bg-surface-muted text-text-muted">{{ enabledCount }} / {{ options.length }} 已允许</span>
    </div>

    <div class="mt-4 flex flex-wrap items-center gap-2">
      <input
        v-model="query"
        class="input-base min-w-[12rem] flex-1"
        type="search"
        placeholder="搜索工具集或工具名"
        :disabled="disabled"
      />
      <button class="btn-ghost px-2 py-1 text-small" type="button" :disabled="disabled" @click="setAll(true)">全部允许</button>
      <button class="btn-ghost px-2 py-1 text-small" type="button" :disabled="disabled" @click="setAll(false)">全部禁止</button>
      <button class="btn-ghost px-2 py-1 text-small" type="button" :disabled="disabled" @click="restoreDefaults">恢复模式默认</button>
    </div>

    <div class="mt-3 grid gap-2">
      <label
        v-for="option in filteredOptions"
        :key="option.id"
        class="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-sidebar px-3 py-3"
      >
        <input
          class="mt-1 size-4 shrink-0 accent-[var(--accent)]"
          type="checkbox"
          :checked="isEnabled(option)"
          :disabled="disabled"
          @change="toggleOption(option, $event)"
        />
        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-center gap-2">
            <span class="text-ui font-medium text-text-secondary">{{ option.title }}</span>
            <span class="badge-pill bg-surface-muted text-text-subtle">
              {{ modelValue.overrides[option.id] == null ? '模式默认' : '会话覆盖' }}
            </span>
            <span v-if="option.ownerOnly" class="badge-pill bg-surface-muted text-text-subtle">仅主人</span>
            <span v-if="option.debugOnly" class="badge-pill bg-surface-muted text-text-subtle">仅调试</span>
          </span>
          <span class="mt-1 block text-small leading-5 text-text-subtle">{{ option.description }}</span>
          <details class="mt-1.5 text-small text-text-subtle">
            <summary class="cursor-pointer select-none">包含 {{ option.toolNames.length }} 个工具</summary>
            <div class="mt-1 break-all font-mono leading-5 text-text-muted">{{ option.toolNames.join(' · ') }}</div>
          </details>
        </span>
      </label>
      <div v-if="filteredOptions.length === 0" class="rounded border border-dashed border-border-default px-3 py-5 text-center text-small text-text-subtle">
        没有匹配的工具集
      </div>
    </div>
  </section>
</template>
