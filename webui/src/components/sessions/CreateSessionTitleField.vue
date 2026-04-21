<script setup lang="ts">
import { computed } from "vue";
import { resolveCreateSessionTitlePlaceholder } from "./createSessionDefaults";

const props = defineProps<{
  modelValue?: string;
  values?: Record<string, unknown>;
  busy?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const titlePlaceholder = computed(() => resolveCreateSessionTitlePlaceholder(String(props.values?.modeId ?? "")));

function handleInput(event: Event) {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
}
</script>

<template>
  <label class="flex flex-col gap-1.5 text-small text-text-muted">
    显示名称
    <input
      :value="modelValue ?? ''"
      :disabled="busy"
      :placeholder="titlePlaceholder"
      class="input-base text-ui"
      @input="handleInput"
    />
    <span class="text-small text-text-subtle">可选。用于列表、标题栏和聊天区展示。</span>
  </label>
</template>
