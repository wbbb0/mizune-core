<script setup lang="ts">
import { computed, reactive, ref, toRaw, watch } from "vue";
import type {
  DialogAction,
  DialogBlock,
  DialogField,
  WindowDialogController,
  WindowDefinition,
  WindowResult
} from "./types";

type DialogValues = Record<string, unknown>;
type DialogPath = string[];

const props = defineProps<{
  windowId: string;
  definition: WindowDefinition<DialogValues, unknown>;
}>();

const emit = defineEmits<{
  resolve: [result: WindowResult<unknown, DialogValues>];
}>();

const values = reactive<DialogValues>({});
const busyActionId = ref<string | null>(null);
const isBusy = computed(() => busyActionId.value !== null);

const blocks = computed(() => props.definition.blocks ?? []);
const fields = computed(() => props.definition.schema?.fields ?? []);
const actions = computed(() => props.definition.actions ?? []);

function isPlainRecord(value: unknown): value is DialogValues {
  if (!value || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonePlain<T>(input: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(input);
  }
  return JSON.parse(JSON.stringify(input)) as T;
}

function resolvePath(fieldKey: string, groupKey?: string): DialogPath {
  return groupKey ? [groupKey, fieldKey] : [fieldKey];
}

function getValueAtPath(path: DialogPath) {
  let current: unknown = values;
  for (const segment of path) {
    if (!isPlainRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function resolveTextValue(path: DialogPath) {
  const value = getValueAtPath(path);
  return typeof value === "string" ? value : "";
}

function resolveNumberValue(path: DialogPath) {
  const value = getValueAtPath(path);
  return typeof value === "number" ? value : 0;
}

function setValueAtPath(path: DialogPath, nextValue: unknown) {
  if (path.length === 0) {
    return;
  }

  let current: DialogValues = values;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const nextValueAtSegment = current[segment];
    if (!isPlainRecord(nextValueAtSegment)) {
      current[segment] = {};
    }
    current = current[segment] as DialogValues;
  }

  current[path[path.length - 1]!] = nextValue;
}

function createDefaultValue(field: DialogField<DialogValues>) {
  switch (field.kind) {
    case "string":
    case "textarea":
      return field.defaultValue ?? "";
    case "number":
      return field.defaultValue ?? field.min ?? 0;
    case "boolean":
      return field.defaultValue ?? false;
    case "enum":
      return field.defaultValue ?? field.options[0]?.value ?? "";
    case "group":
      return reconcileFields(field.fields, {});
    case "custom":
      return undefined;
  }
}

function resolveNumberFallback(field: Extract<DialogField<DialogValues>, { kind: "number" }>) {
  return field.defaultValue ?? field.min ?? 0;
}

function createFieldValue(field: DialogField<DialogValues>, currentValues: DialogValues) {
  if (Object.prototype.hasOwnProperty.call(currentValues, field.key)) {
    const currentValue = currentValues[field.key];
    if (field.kind === "group") {
      return reconcileFields(field.fields, isPlainRecord(currentValue) ? currentValue : {});
    }
    return clonePlain(currentValue);
  }
  return createDefaultValue(field);
}

function reconcileFields(fieldsToReconcile: readonly DialogField<DialogValues>[], currentValues: DialogValues) {
  return fieldsToReconcile.reduce<DialogValues>((accumulator, field) => {
    accumulator[field.key] = createFieldValue(field, currentValues);
    return accumulator;
  }, {});
}

function syncValues() {
  const nextValues = reconcileFields(fields.value, toRaw(values) as DialogValues);

  for (const key of Object.keys(values)) {
    if (!(key in nextValues)) {
      delete values[key];
    }
  }

  Object.assign(values, nextValues);
}

watch(fields, syncValues, { immediate: true });

function snapshotValues() {
  return clonePlain(toRaw(values)) as DialogValues;
}

defineExpose<WindowDialogController<DialogValues>>({
  snapshotValues
});

function handleStringInput(fieldKey: string, event: Event, groupKey?: string) {
  setValueAtPath(resolvePath(fieldKey, groupKey), (event.target as HTMLInputElement | HTMLTextAreaElement).value);
}

function handleNumberInput(field: Extract<DialogField<DialogValues>, { kind: "number" }>, event: Event, groupKey?: string) {
  const rawValue = (event.target as HTMLInputElement).value;
  setValueAtPath(resolvePath(field.key, groupKey), rawValue === "" ? resolveNumberFallback(field) : Number(rawValue));
}

function handleBooleanInput(fieldKey: string, event: Event, groupKey?: string) {
  setValueAtPath(resolvePath(fieldKey, groupKey), (event.target as HTMLInputElement).checked);
}

function handleSelectInput(fieldKey: string, event: Event, groupKey?: string) {
  setValueAtPath(resolvePath(fieldKey, groupKey), (event.target as HTMLSelectElement).value);
}

function resolveCustomFieldProps(field: Extract<DialogField<DialogValues>, { kind: "custom" }>, groupKey?: string) {
  return {
    ...(field.props ?? {}),
    modelValue: getValueAtPath(resolvePath(field.key, groupKey)),
    values,
    windowId: props.windowId,
    busy: isBusy.value
  };
}

function resolveBlockProps(block: DialogBlock<DialogValues>) {
  return block.kind === "component"
    ? {
        ...(block.props ?? {}),
        values,
        windowId: props.windowId,
        busy: isBusy.value
      }
    : {};
}

function resolveComponentReference(component: unknown) {
  return toRaw(component as object);
}

async function handleAction(action: DialogAction<DialogValues, unknown>) {
  if (busyActionId.value !== null) {
    return;
  }

  const currentValues = snapshotValues();
  busyActionId.value = action.id;
  try {
    const result = action.run
      ? await action.run({
          values: currentValues,
          windowId: props.windowId
        })
      : undefined;

    emit("resolve", {
      reason: "action",
      actionId: action.id,
      values: currentValues,
      result
    });
  } catch {
    return;
  } finally {
    busyActionId.value = null;
  }
}

function handleClose() {
  if (busyActionId.value !== null) {
    return;
  }

  emit("resolve", {
    reason: "close",
    values: snapshotValues()
  });
}
</script>

<template>
  <div class="flex flex-1 flex-col gap-4 text-small leading-5 text-text-secondary">
    <div class="flex flex-col gap-4 p-4 flex-1">
      <div v-if="blocks.length" class="flex flex-col gap-3">
        <template v-for="(block, index) in blocks" :key="index">
          <p v-if="block.kind === 'text'" class="whitespace-pre-wrap text-text-secondary">
            {{ block.content }}
          </p>
          <hr v-else-if="block.kind === 'separator'" class="border-border-default" />
          <component v-else :is="resolveComponentReference(block.component)" v-bind="resolveBlockProps(block)" />
        </template>
      </div>

      <form class="flex flex-col gap-4" @submit.prevent>
        <template v-for="field in fields" :key="field.key">
          <label v-if="field.kind === 'string'" class="flex flex-col gap-1.5 text-small text-text-muted">
            {{ field.label }}
            <input
              :value="getValueAtPath(resolvePath(field.key)) ?? ''"
              :placeholder="field.placeholder"
              :required="field.required ?? false"
              class="input-base text-ui"
              type="text"
              @input="handleStringInput(field.key, $event)"
            />
          </label>

          <label v-else-if="field.kind === 'textarea'" class="flex flex-col gap-1.5 text-small text-text-muted">
            {{ field.label }}
            <textarea
              :value="resolveTextValue(resolvePath(field.key))"
              :placeholder="field.placeholder"
              class="input-base min-h-28 text-ui"
              @input="handleStringInput(field.key, $event)"
            />
          </label>

          <label v-else-if="field.kind === 'number'" class="flex flex-col gap-1.5 text-small text-text-muted">
            {{ field.label }}
            <input
              :value="resolveNumberValue(resolvePath(field.key))"
              :max="field.max"
              :min="field.min"
              class="input-base text-ui"
              type="number"
              @input="handleNumberInput(field, $event)"
            />
          </label>

          <label v-else-if="field.kind === 'boolean'" class="flex items-center gap-2 text-small text-text-muted">
            <input
              :checked="Boolean(getValueAtPath(resolvePath(field.key)))"
              class="h-4 w-4 rounded border-border-default bg-surface-panel text-accent"
              type="checkbox"
              @change="handleBooleanInput(field.key, $event)"
            />
            <span>{{ field.label }}</span>
          </label>

          <label v-else-if="field.kind === 'enum'" class="flex flex-col gap-1.5 text-small text-text-muted">
            {{ field.label }}
            <select
              :value="getValueAtPath(resolvePath(field.key)) ?? ''"
              class="input-base text-ui"
              @change="handleSelectInput(field.key, $event)"
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

            <template v-for="childField in field.fields" :key="childField.key">
              <label v-if="childField.kind === 'string'" class="flex flex-col gap-1.5 text-small text-text-muted">
                {{ childField.label }}
                <input
                  :value="getValueAtPath(resolvePath(childField.key, field.key)) ?? ''"
                  :placeholder="childField.placeholder"
                  :required="childField.required ?? false"
                  class="input-base text-ui"
                  type="text"
                  @input="handleStringInput(childField.key, $event, field.key)"
                />
              </label>

              <label v-else-if="childField.kind === 'textarea'" class="flex flex-col gap-1.5 text-small text-text-muted">
                {{ childField.label }}
                <textarea
                  :value="resolveTextValue(resolvePath(childField.key, field.key))"
                  :placeholder="childField.placeholder"
                  class="input-base min-h-28 text-ui"
                  @input="handleStringInput(childField.key, $event, field.key)"
                />
              </label>

              <label v-else-if="childField.kind === 'number'" class="flex flex-col gap-1.5 text-small text-text-muted">
                {{ childField.label }}
                <input
                  :value="resolveNumberValue(resolvePath(childField.key, field.key))"
                  :max="childField.max"
                  :min="childField.min"
                  class="input-base text-ui"
                  type="number"
                  @input="handleNumberInput(childField, $event, field.key)"
                />
              </label>

              <label v-else-if="childField.kind === 'boolean'" class="flex items-center gap-2 text-small text-text-muted">
                <input
                  :checked="Boolean(getValueAtPath(resolvePath(childField.key, field.key)))"
                  class="h-4 w-4 rounded border-border-default bg-surface-panel text-accent"
                  type="checkbox"
                  @change="handleBooleanInput(childField.key, $event, field.key)"
                />
                <span>{{ childField.label }}</span>
              </label>

              <label v-else-if="childField.kind === 'enum'" class="flex flex-col gap-1.5 text-small text-text-muted">
                {{ childField.label }}
                <select
                  :value="getValueAtPath(resolvePath(childField.key, field.key)) ?? ''"
                  class="input-base text-ui"
                  @change="handleSelectInput(childField.key, $event, field.key)"
                >
                  <option v-for="option in childField.options" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </label>

              <component
                v-else-if="childField.kind === 'custom'"
                :is="resolveComponentReference(childField.component)"
                v-bind="resolveCustomFieldProps(childField, field.key)"
                @update:modelValue="setValueAtPath(resolvePath(childField.key, field.key), $event)"
              />
            </template>
          </fieldset>

          <component
            v-else-if="field.kind === 'custom'"
            :is="resolveComponentReference(field.component)"
            v-bind="resolveCustomFieldProps(field)"
            @update:modelValue="setValueAtPath(resolvePath(field.key), $event)"
          />
        </template>
      </form>
    </div>

    <div class="flex flex-wrap items-center justify-end gap-2 border-t border-border-default p-4">
      <button
        class="btn btn-secondary max-w-full whitespace-normal text-left"
        :disabled="isBusy"
        data-action-kind="close"
        type="button"
        @click="handleClose"
      >
        取消
      </button>

      <button
        v-for="action in actions"
        :key="action.id"
        :class="[
          'max-w-full whitespace-normal text-left',
          action.variant === 'danger'
            ? 'btn btn-danger'
            : action.variant === 'secondary'
              ? 'btn btn-secondary'
              : 'btn btn-primary'
        ]"
        :data-action-id="action.id"
        :disabled="isBusy"
        type="button"
        @click="handleAction(action)"
      >
        {{ busyActionId === action.id ? "处理中…" : action.label }}
      </button>
    </div>
  </div>
</template>
