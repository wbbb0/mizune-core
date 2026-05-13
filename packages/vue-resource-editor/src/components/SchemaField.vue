<script setup lang="ts">
/**
 * Renders a single leaf field based on schema kind.
 * Emits "update" with the new value whenever the user changes the input.
 */
import { computed, ref, watchEffect } from "vue";
import type { SchemaMeta } from "../types";
import { useResourceEditorClient } from "../resourceEditorClient";

const props = defineProps<{
  schema: SchemaMeta;
  modelValue: unknown;
  inherited?: unknown; // read-only value from parent layers
  defaultValue?: unknown;
  disabled?: boolean;
  readOnly?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

// dynamic ref options
const dynamicOptions = ref<string[] | null>(null);
const dynamicOptionsError = ref(false);
const editorClient = useResourceEditorClient();
const displayedValue = computed(() => {
  if (props.modelValue !== undefined) {
    return props.modelValue;
  }
  if (props.inherited !== undefined) {
    return props.inherited;
  }
  return props.defaultValue;
});

watchEffect(() => {
  if (props.schema.kind === "string" && props.schema.dynamicRef) {
    const key = props.schema.dynamicRef;
    dynamicOptions.value = null;
    dynamicOptionsError.value = false;
    if (!editorClient?.options) {
      dynamicOptionsError.value = true;
      return;
    }
    editorClient.options(key).then((res) => {
      dynamicOptions.value = res.options;
    }).catch(() => {
      dynamicOptionsError.value = true;
    });
  }
});

function onInput(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  if (props.schema.kind === "number") {
    const n = props.schema.integer ? parseInt(v, 10) : parseFloat(v);
    emit("update:modelValue", isNaN(n) ? null : n);
  } else {
    emit("update:modelValue", v);
  }
}

function onBoolChange(e: Event) {
  emit("update:modelValue", (e.target as HTMLInputElement).checked);
}

function onEnumChange(e: Event) {
  emit("update:modelValue", (e.target as HTMLSelectElement).value);
}

function currentStringValue(): string {
  return displayedValue.value !== undefined ? String(displayedValue.value) : "";
}

function onJsonInput(event: Event) {
  try {
    emit("update:modelValue", JSON.parse((event.target as HTMLTextAreaElement).value));
  } catch {
    // Keep the previous valid value while the user is editing invalid JSON.
  }
}

const readOnlyText = computed(() => {
  const value = displayedValue.value;
  if (value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return JSON.stringify(value, null, 2);
});

const readOnlyMultiline = computed(() => {
  const value = displayedValue.value;
  return (
    value != null
    && typeof value === "object"
  ) || readOnlyText.value.includes("\n") || readOnlyText.value.length > 120;
});

</script>

<template>
  <template v-if="readOnly">
    <pre
      v-if="readOnlyMultiline"
      class="scrollbar-thin m-0 max-h-80 overflow-auto rounded border border-border-subtle bg-surface-muted px-2 py-1.5 font-mono text-mono leading-5 text-text-primary whitespace-pre-wrap wrap-break-word"
    >{{ readOnlyText }}</pre>
    <span
      v-else
      class="font-mono text-mono leading-5 wrap-break-word"
      :class="displayedValue === undefined ? 'text-text-subtle' : 'text-text-primary'"
    >{{ readOnlyText }}</span>
  </template>

  <!-- boolean -->
  <label
    v-else-if="schema.kind === 'boolean'"
    class="flex cursor-pointer items-center gap-1.5 rounded-md"
  >
    <input
      type="checkbox"
      class="cursor-pointer accent-accent"
      :checked="displayedValue === true"
      :disabled="disabled"
      @change="onBoolChange"
    />
    <span
      class="text-ui text-text-primary"
    >{{ displayedValue }}</span>
  </label>

  <!-- enum -->
  <select
    v-else-if="schema.kind === 'enum'"
    class="input-base h-6 max-w-60 px-1.5 py-0.5"
    :value="displayedValue !== undefined ? String(displayedValue) : ''"
    :disabled="disabled"
    @change="onEnumChange"
  >
    <option v-for="opt in schema.values" :key="String(opt)" :value="String(opt)">{{ opt }}</option>
  </select>

  <!-- literal (read-only display) -->
  <span v-else-if="schema.kind === 'literal'" class="font-mono text-mono text-text-muted">{{ schema.value }}</span>

  <!-- number -->
  <input
    v-else-if="schema.kind === 'number'"
    type="number"
    class="input-base h-6 max-w-40 px-1.5 py-0.5"
    :value="displayedValue as number"
    :step="schema.integer ? 1 : 'any'"
    :min="schema.min"
    :max="schema.max"
    :disabled="disabled"
    @input="onInput"
  />

  <!-- string with dynamicRef — dropdown populated from API -->
  <template v-else-if="schema.kind === 'string' && schema.dynamicRef">
    <select
      v-if="dynamicOptions !== null && !dynamicOptionsError"
      class="input-base h-6 max-w-60 px-1.5 py-0.5"
      :value="currentStringValue()"
      :disabled="disabled"
      @change="onEnumChange"
    >
      <option value="">—</option>
      <option v-for="opt in dynamicOptions" :key="opt" :value="opt">{{ opt }}</option>
    </select>
    <span v-else-if="dynamicOptionsError" class="text-ui text-text-muted">
      <textarea
        class="input-base min-h-7 w-full max-w-120 resize-y text-ui leading-[1.4]"
        :value="currentStringValue()"
        :disabled="disabled"
        rows="2"
        @input="onInput"
      />
    </span>
    <span v-else class="text-ui text-text-muted italic text-xs">加载中…</span>
    <span
      v-if="dynamicOptions !== null && currentStringValue() && !dynamicOptions.includes(currentStringValue())"
      class="ml-1 text-xs text-orange-400"
    >不在清单中</span>
  </template>

  <!-- string / null / unknown — textarea for multi-line, input for short -->
  <textarea
    v-else-if="schema.kind === 'string'"
    class="input-base min-h-7 w-full max-w-120 resize-y text-ui leading-[1.4]"
    :value="displayedValue !== undefined ? String(displayedValue) : ''"
    :disabled="disabled"
    rows="2"
    @input="onInput"
  />

  <!-- fallback: JSON text -->
  <textarea
    v-else
    class="input-base min-h-7 w-full max-w-120 resize-y font-mono text-ui leading-[1.4]"
    :value="JSON.stringify(displayedValue, null, 2)"
    :disabled="disabled"
    rows="3"
    @input="onJsonInput"
  />
</template>
