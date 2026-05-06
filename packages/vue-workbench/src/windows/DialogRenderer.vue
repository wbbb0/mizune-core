<script setup lang="ts">
import { computed, reactive, ref, toRaw, watch } from "vue";
import DialogFieldRenderer from "./DialogFieldRenderer.vue";
import type {
  WorkbenchDialogAction,
  WorkbenchDialogBlock,
  WorkbenchDialogField,
  WorkbenchWindowDialogController,
  WorkbenchWindowDefinition,
  WorkbenchWindowResult
} from "./types";

type DialogValues = Record<string, unknown>;
type DialogPath = string[];

const props = defineProps<{
  windowId: string;
  definition: WorkbenchWindowDefinition<DialogValues, unknown>;
}>();

const emit = defineEmits<{
  resolve: [result: WorkbenchWindowResult<unknown, DialogValues>];
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

function createDefaultValue(field: WorkbenchDialogField<DialogValues>) {
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

function createFieldValue(field: WorkbenchDialogField<DialogValues>, currentValues: DialogValues) {
  if (Object.prototype.hasOwnProperty.call(currentValues, field.key)) {
    const currentValue = currentValues[field.key];
    if (field.kind === "group") {
      return reconcileFields(field.fields, isPlainRecord(currentValue) ? currentValue : {});
    }
    return clonePlain(currentValue);
  }
  return createDefaultValue(field);
}

function reconcileFields(fieldsToReconcile: readonly WorkbenchDialogField<DialogValues>[], currentValues: DialogValues) {
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

defineExpose<WorkbenchWindowDialogController<DialogValues>>({
  snapshotValues
});

function resolveBlockProps(block: WorkbenchDialogBlock<DialogValues>) {
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

async function handleAction(action: WorkbenchDialogAction<DialogValues, unknown>) {
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
        <DialogFieldRenderer
          v-for="field in fields"
          :key="field.key"
          :field="field"
          :values="values"
          :window-id="windowId"
          :busy="isBusy"
          :get-value-at-path="getValueAtPath"
          :set-value-at-path="setValueAtPath"
        />
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
