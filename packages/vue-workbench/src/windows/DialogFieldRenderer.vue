<script setup lang="ts">
import { computed, toRaw } from "vue";
import type { WorkbenchDialogField } from "./types";

type DialogValues = Record<string, unknown>;
type DialogPath = string[];

defineOptions({
  name: "DialogFieldRenderer"
});

const props = withDefaults(defineProps<{
  field: WorkbenchDialogField<DialogValues>;
  pathPrefix?: DialogPath;
  values: DialogValues;
  windowId: string;
  busy: boolean;
  getValueAtPath: (path: DialogPath) => unknown;
  setValueAtPath: (path: DialogPath, value: unknown) => void;
}>(), {
  pathPrefix: () => []
});

const fieldPath = computed(() => [...props.pathPrefix, props.field.key]);

function resolveTextValue(path: DialogPath) {
  const value = props.getValueAtPath(path);
  return typeof value === "string" ? value : "";
}

function resolveNumberValue(path: DialogPath) {
  const value = props.getValueAtPath(path);
  return typeof value === "number" ? value : 0;
}

function resolveNumberFallback(field: Extract<WorkbenchDialogField<DialogValues>, { kind: "number" }>) {
  return field.defaultValue ?? field.min ?? 0;
}

function handleStringInput(event: Event) {
  props.setValueAtPath(fieldPath.value, (event.target as HTMLInputElement | HTMLTextAreaElement).value);
}

function handleNumberInput(field: Extract<WorkbenchDialogField<DialogValues>, { kind: "number" }>, event: Event) {
  const rawValue = (event.target as HTMLInputElement).value;
  props.setValueAtPath(fieldPath.value, rawValue === "" ? resolveNumberFallback(field) : Number(rawValue));
}

function handleBooleanInput(event: Event) {
  props.setValueAtPath(fieldPath.value, (event.target as HTMLInputElement).checked);
}

function handleSelectInput(event: Event) {
  props.setValueAtPath(fieldPath.value, (event.target as HTMLSelectElement).value);
}

function resolveCustomFieldProps(field: Extract<WorkbenchDialogField<DialogValues>, { kind: "custom" }>) {
  return {
    ...(field.props ?? {}),
    modelValue: props.getValueAtPath(fieldPath.value),
    values: props.values,
    windowId: props.windowId,
    busy: props.busy
  };
}

function resolveComponentReference(component: unknown) {
  return toRaw(component as object);
}
</script>

<template>
  <label v-if="field.kind === 'string'" class="flex flex-col gap-1.5 text-small text-text-muted">
    {{ field.label }}
    <input
      :value="getValueAtPath(fieldPath) ?? ''"
      :placeholder="field.placeholder"
      :required="field.required ?? false"
      class="input-base text-ui"
      type="text"
      @input="handleStringInput"
    />
  </label>

  <label v-else-if="field.kind === 'textarea'" class="flex flex-col gap-1.5 text-small text-text-muted">
    {{ field.label }}
    <textarea
      :value="resolveTextValue(fieldPath)"
      :placeholder="field.placeholder"
      class="input-base min-h-28 text-ui"
      @input="handleStringInput"
    />
  </label>

  <label v-else-if="field.kind === 'number'" class="flex flex-col gap-1.5 text-small text-text-muted">
    {{ field.label }}
    <input
      :value="resolveNumberValue(fieldPath)"
      :max="field.max"
      :min="field.min"
      class="input-base text-ui"
      type="number"
      @input="handleNumberInput(field, $event)"
    />
  </label>

  <label v-else-if="field.kind === 'boolean'" class="flex items-center gap-2 text-small text-text-muted">
    <input
      :checked="Boolean(getValueAtPath(fieldPath))"
      class="h-4 w-4 rounded border-border-default bg-surface-panel text-accent"
      type="checkbox"
      @change="handleBooleanInput"
    />
    <span>{{ field.label }}</span>
  </label>

  <label v-else-if="field.kind === 'enum'" class="flex flex-col gap-1.5 text-small text-text-muted">
    {{ field.label }}
    <select
      :value="getValueAtPath(fieldPath) ?? ''"
      class="input-base text-ui"
      @change="handleSelectInput"
    >
      <option v-for="option in field.options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
  </label>

  <fieldset
    v-else-if="field.kind === 'group'"
    class="flex flex-col gap-3 rounded border border-border-default bg-surface-sidebar px-3 py-3"
  >
    <legend class="px-1 text-small font-medium text-text-secondary">
      {{ field.label }}
    </legend>

    <DialogFieldRenderer
      v-for="childField in field.fields"
      :key="childField.key"
      :field="childField"
      :path-prefix="fieldPath"
      :values="values"
      :window-id="windowId"
      :busy="busy"
      :get-value-at-path="getValueAtPath"
      :set-value-at-path="setValueAtPath"
    />
  </fieldset>

  <component
    v-else-if="field.kind === 'custom'"
    :is="resolveComponentReference(field.component)"
    v-bind="resolveCustomFieldProps(field)"
    @update:modelValue="setValueAtPath(fieldPath, $event)"
  />
</template>
