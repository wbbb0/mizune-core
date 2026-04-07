<script setup lang="ts">
/**
 * Renders a single leaf field based on schema kind.
 * Emits "update" with the new value whenever the user changes the input.
 */
import { ref, watchEffect } from "vue";
import type { SchemaMeta } from "@/api/editor";
import { editorApi } from "@/api/editor";

const props = defineProps<{
  schema: SchemaMeta;
  modelValue: unknown;
  inherited?: unknown; // read-only value from parent layers
  backdrop?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

// dynamic ref options
const dynamicOptions = ref<string[] | null>(null);
const dynamicOptionsError = ref(false);

watchEffect(() => {
  if (props.schema.kind === "string" && props.schema.dynamicRef) {
    const key = props.schema.dynamicRef;
    dynamicOptions.value = null;
    dynamicOptionsError.value = false;
    editorApi.options(key).then((res) => {
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
  return props.modelValue !== undefined ? String(props.modelValue) : String(props.inherited ?? "");
}

</script>

<template>
  <!-- boolean -->
  <label v-if="schema.kind === 'boolean'" class="flex cursor-pointer items-center gap-1.5 rounded-md" :class="backdrop ? 'editor-backdrop-field px-2 py-1' : ''">
    <input
      type="checkbox"
      class="cursor-pointer accent-accent"
      :checked="modelValue === true || (modelValue === undefined && inherited === true)"
      :disabled="disabled"
      @change="onBoolChange"
    />
    <span class="text-ui" :class="backdrop ? 'editor-backdrop-value' : 'text-text-primary'">{{ modelValue !== undefined ? modelValue : inherited }}</span>
  </label>

  <!-- enum -->
  <select
    v-else-if="schema.kind === 'enum'"
    class="input-base h-6 max-w-60 px-1.5 py-0.5"
    :class="backdrop ? 'editor-backdrop-input editor-backdrop-value' : ''"
    :value="modelValue !== undefined ? String(modelValue) : String(inherited ?? '')"
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
    :class="backdrop ? 'editor-backdrop-input editor-backdrop-value' : ''"
    :value="modelValue !== undefined ? modelValue as number : inherited as number"
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
      :class="backdrop ? 'editor-backdrop-input editor-backdrop-value' : ''"
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
        :class="backdrop ? 'editor-backdrop-input editor-backdrop-value' : ''"
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
    :class="backdrop ? 'editor-backdrop-input editor-backdrop-value' : ''"
    :value="modelValue !== undefined ? String(modelValue) : String(inherited ?? '')"
    :disabled="disabled"
    rows="2"
    @input="onInput"
  />

  <!-- fallback: JSON text -->
  <textarea
    v-else
    class="input-base min-h-7 w-full max-w-120 resize-y font-mono text-ui leading-[1.4]"
    :class="backdrop ? 'editor-backdrop-input editor-backdrop-value' : ''"
    :value="JSON.stringify(modelValue !== undefined ? modelValue : inherited, null, 2)"
    :disabled="disabled"
    rows="3"
    @input="(e) => { try { emit('update:modelValue', JSON.parse((e.target as HTMLTextAreaElement).value)); } catch {} }"
  />
</template>
