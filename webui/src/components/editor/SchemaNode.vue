<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { Plus, Trash2, ArrowUp, ArrowDown, Pencil, Check, Undo2, Copy } from "lucide-vue-next";
import SchemaField from "./SchemaField.vue";
import TreeNodeShell from "@/components/tree/TreeNodeShell.vue";
import type { LayerFeatures, UiNode } from "@/api/editor";
import { deepEqual, removeValueAtPathAndPrune, type PathSegment } from "@/utils/editorState";

type HeaderActionIcon = "trash" | "up" | "down" | "pencil" | "check" | "restore" | "copy";

interface HeaderAction {
  key: string;
  icon: HeaderActionIcon;
  title: string;
  disabled?: boolean;
  danger?: boolean;
  submitEdit?: boolean;
  onClick: () => void;
}

const props = defineProps<{
  node: UiNode;
  fieldKey?: string;
  modelValue: unknown;
  inherited?: unknown;
  baseValue?: unknown;
  storedValue?: unknown;
  effectiveValue?: unknown;
  path?: PathSegment[];
  isLayered?: boolean;
  layerFeatures?: LayerFeatures;
  depth?: number;
  disabled?: boolean;
  headerLabel?: string;
  headerMeta?: string | number;
  headerActions?: HeaderAction[];
  headerEditing?: boolean;
  headerEditValue?: string;
  headerEditPlaceholder?: string;
  forceHeader?: boolean;
  onHeaderEditSubmit?: (value: string) => void;
}>();

const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

const depth = computed(() => props.depth ?? 0);
const path = computed(() => props.path ?? []);
const open = ref(depth.value <= 0); // 若要默认展开n层，改为 depth.value <= n

function asObj(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return { ...asObj(value) };
}

function emitObjectWithoutUndefined(value: Record<string, unknown>) {
  if (Object.keys(value).length === 0) {
    emit("update:modelValue", undefined);
    return;
  }
  emit("update:modelValue", value);
}

function appendPath(segment: PathSegment): PathSegment[] {
  return [...path.value, segment];
}

const label = computed(() => props.headerLabel ?? props.node.schema.title ?? props.fieldKey ?? "");
const headerMeta = computed(() => {
  if (props.headerMeta !== undefined) {
    return props.headerMeta;
  }
  if (props.node.kind === "array") {
    return items.value.length;
  }
  if (props.node.kind === "record") {
    return recordEntries.value.length;
  }
  return undefined;
});
const headerActions = computed(() => props.headerActions ?? []);
const showNodeHeader = computed(() => {
  if (props.forceHeader) {
    return true;
  }
  if (props.headerEditing) {
    return true;
  }
  return label.value.trim().length > 0 || mergedHeaderActions.value.length > 0 || headerMeta.value !== undefined;
});
const showGroupHeader = computed(() => depth.value > 0 && showNodeHeader.value);
const showFieldHeader = computed(() => showNodeHeader.value);
const headerEditDraft = ref(props.headerEditValue ?? label.value);

watch(
  () => [props.headerEditing, props.headerEditValue, label.value] as const,
  ([editing, editValue, nextLabel]) => {
    if (editing) {
      headerEditDraft.value = editValue ?? nextLabel;
    }
  },
  { immediate: true }
);

function actionIcon(icon: HeaderActionIcon) {
  switch (icon) {
    case "trash":
      return Trash2;
    case "up":
      return ArrowUp;
    case "down":
      return ArrowDown;
    case "pencil":
      return Pencil;
    case "check":
      return Check;
    case "restore":
      return Undo2;
    case "copy":
      return Copy;
  }
}

function submitHeaderEdit() {
  props.onHeaderEditSubmit?.(headerEditDraft.value);
}

function onHeaderEditBlur() {
  submitHeaderEdit();
}

function onHeaderEditEnter(event: Event) {
  submitHeaderEdit();
  (event.target as HTMLInputElement).blur();
}

function onHeaderActionClick(action: HeaderAction) {
  if (action.submitEdit) {
    submitHeaderEdit();
    return;
  }
  action.onClick();
}
function childInheritedValue(key: string): unknown {
  return asObj(props.inherited)[key];
}

function childBaseValue(key: string): unknown {
  return asObj(props.baseValue)[key];
}

function childStoredValue(key: string): unknown {
  return asObj(props.storedValue)[key];
}

function childEffectiveValue(key: string): unknown {
  return asObj(props.effectiveValue)[key];
}

const currentPathDirty = computed(() => !deepEqual(props.modelValue, props.storedValue));
const showLayeredTone = computed(() => !!props.isLayered && !!props.layerFeatures?.showBackdrop);
const canRestoreInherited = computed(() =>
  !!props.isLayered
  && !!props.layerFeatures?.allowRestoreInherited
  && path.value.length > 0
  && props.modelValue !== undefined
);
const showLocalValue = computed(() =>
  showLayeredTone.value
  && path.value.length > 0
  && props.modelValue !== undefined
);

function restoreInherited() {
  const next = removeValueAtPathAndPrune(props.modelValue, []);
  emit("update:modelValue", next);
}

const nodeClasses = computed(() => (
  showLocalValue.value ? "editor-node-layered-local" : ""
));

const labelClasses = computed(() => [
  "tree-label",
  "text-small",
  showLocalValue.value ? "font-bold" : "font-medium",
  currentPathDirty.value ? "tree-label-dirty" : ""
].filter(Boolean).join(" "));

const mergedHeaderActions = computed<HeaderAction[]>(() => {
  const next = [...headerActions.value];
  if (canRestoreInherited.value && !props.disabled) {
    next.unshift({
      key: `restore-${path.value.join(".") || "root"}`,
      icon: "restore",
      title: "恢复继承",
      onClick: restoreInherited
    });
  }
  return next;
});

function onGroupChildUpdate(key: string, childValue: unknown) {
  const current = cloneRecord(props.modelValue);
  if (childValue === undefined) {
    delete current[key];
  } else {
    current[key] = childValue;
  }
  emitObjectWithoutUndefined(current);
}

const items = computed(() => asArr(props.modelValue));
const inheritedItems = computed(() => asArr(props.inherited));
const baseItems = computed(() => asArr(props.baseValue));
const storedItems = computed(() => asArr(props.storedValue));
const effectiveItems = computed(() => asArr(props.effectiveValue));

function isComplexNode(node: UiNode): boolean {
  return node.kind !== "field";
}

const editingRecordKey = ref<string | null>(null);

function inheritedArrayItem(index: number): unknown {
  return inheritedItems.value[index];
}

function baseArrayItem(index: number): unknown {
  return baseItems.value[index];
}

function storedArrayItem(index: number): unknown {
  return storedItems.value[index];
}

function effectiveArrayItem(index: number): unknown {
  return effectiveItems.value[index];
}

function onArrayItemUpdate(index: number, childValue: unknown) {
  const next = [...items.value];
  next[index] = childValue;
  emit("update:modelValue", next);
}

function addArrayItem() {
  emit("update:modelValue", [...items.value, null]);
}

function removeArrayItem(index: number) {
  const next = [...items.value];
  next.splice(index, 1);
  emit("update:modelValue", next.length > 0 ? next : undefined);
}

function moveArrayItem(index: number, offset: -1 | 1) {
  const targetIndex = index + offset;
  if (targetIndex < 0 || targetIndex >= items.value.length) return;
  const next = [...items.value];
  const [entry] = next.splice(index, 1);
  next.splice(targetIndex, 0, entry);
  emit("update:modelValue", next);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function duplicateArrayItem(index: number) {
  const next = [...items.value];
  const copy = jsonClone(next[index]);
  next.splice(index + 1, 0, copy);
  emit("update:modelValue", next);
}

const recordEntries = computed(() => Object.entries(asObj(props.modelValue)));
const inheritedRecord = computed(() => asObj(props.inherited));
const baseRecord = computed(() => asObj(props.baseValue));
const storedRecord = computed(() => asObj(props.storedValue));
const effectiveRecord = computed(() => asObj(props.effectiveValue));

function inheritedRecordValue(key: string): unknown {
  return inheritedRecord.value[key];
}

function baseRecordValue(key: string): unknown {
  return baseRecord.value[key];
}

function storedRecordValue(key: string): unknown {
  return storedRecord.value[key];
}

function effectiveRecordValue(key: string): unknown {
  return effectiveRecord.value[key];
}

function onRecordValueUpdate(key: string, childValue: unknown) {
  const next = cloneRecord(props.modelValue);
  if (childValue === undefined) {
    delete next[key];
  } else {
    next[key] = childValue;
  }
  emitObjectWithoutUndefined(next);
}

function addRecordEntry() {
  const next = cloneRecord(props.modelValue);
  let index = Object.keys(next).length + 1;
  let key = `key_${index}`;
  while (key in next) {
    index += 1;
    key = `key_${index}`;
  }
  next[key] = null;
  emit("update:modelValue", next);
}

function removeRecordEntry(key: string) {
  const next = cloneRecord(props.modelValue);
  delete next[key];
  emitObjectWithoutUndefined(next);
}

function duplicateRecordEntry(key: string) {
  const next = cloneRecord(props.modelValue);
  const copy = jsonClone(next[key]);
  let newKey = `${key}_copy`;
  let suffix = 2;
  while (newKey in next) {
    newKey = `${key}_copy${suffix}`;
    suffix += 1;
  }
  // insert right after the original key by rebuilding entry order
  const entries = Object.entries(next);
  const insertAt = entries.findIndex(([k]) => k === key) + 1;
  entries.splice(insertAt, 0, [newKey, copy]);
  emit("update:modelValue", Object.fromEntries(entries));
}

function renameRecordKey(oldKey: string, rawKey: string) {
  const trimmedKey = rawKey.trim();
  if (!trimmedKey || trimmedKey === oldKey) return;

  const entries = recordEntries.value.map(([key, value]) => [key, value] as const);
  if (entries.some(([key]) => key === trimmedKey)) return;

  const renamed = entries.map(([key, value]) => (key === oldKey ? [trimmedKey, value] : [key, value]));
  emit("update:modelValue", Object.fromEntries(renamed));
}

function moveRecordEntry(key: string, offset: -1 | 1) {
  const entries = recordEntries.value.map(([entryKey, value]) => [entryKey, value] as const);
  const index = entries.findIndex(([entryKey]) => entryKey === key);
  const targetIndex = index + offset;
  if (index < 0 || targetIndex < 0 || targetIndex >= entries.length) return;
  const [entry] = entries.splice(index, 1);
  entries.splice(targetIndex, 0, entry);
  emit("update:modelValue", Object.fromEntries(entries));
}

function recordHeaderActions(key: string, idx: number): HeaderAction[] {
  return [
    editingRecordKey.value === key
      ? {
          key: `record-confirm-${key}`,
          icon: "check",
          title: "确认重命名",
          submitEdit: true,
          onClick: () => {}
        }
      : {
          key: `record-rename-${key}`,
          icon: "pencil",
          title: "重命名",
          onClick: () => {
            editingRecordKey.value = key;
          }
        },
    {
      key: `record-up-${key}`,
      icon: "up",
      title: "上移",
      disabled: idx === 0,
      onClick: () => moveRecordEntry(key, -1)
    },
    {
      key: `record-down-${key}`,
      icon: "down",
      title: "下移",
      disabled: idx === recordEntries.value.length - 1,
      onClick: () => moveRecordEntry(key, 1)
    },
    {
      key: `record-copy-${key}`,
      icon: "copy",
      title: "复制",
      onClick: () => duplicateRecordEntry(key)
    },
    {
      key: `record-remove-${key}`,
      icon: "trash",
      title: "删除",
      danger: true,
      onClick: () => removeRecordEntry(key)
    }
  ];
}

const unionOptions = computed(() => (props.node.kind === "union" ? props.node.options : []));
const selectedUnionIdx = ref(0);

function getLeafLiteralLabel(node: UiNode): string | null {
  if (node.kind !== "field") return null;
  if (node.schema.kind === "literal") {
    return String(node.schema.value);
  }
  if (node.schema.kind === "enum" && node.schema.values?.length === 1) {
    return String(node.schema.values[0]);
  }
  return null;
}

function getUnionOptionLabel(node: UiNode, index: number): string {
  if (node.schema.title?.trim()) {
    return node.schema.title;
  }

  if (node.kind === "field") {
    return getLeafLiteralLabel(node) ?? node.schema.kind;
  }

  if (node.kind === "group") {
    const discriminatorKeys = ["type", "kind", "mode", "name"];
    for (const key of discriminatorKeys) {
      const child = node.children[key];
      if (!child) continue;
      const label = getLeafLiteralLabel(child);
      if (label) return label;
    }
  }

  return `选项 ${index + 1}`;
}

function onUnionSelect(event: Event) {
  selectedUnionIdx.value = parseInt((event.target as HTMLSelectElement).value, 10);
  emit("update:modelValue", null);
}
</script>

<template>
  <div v-if="node.kind === 'field'" :class="['editor-field-row flex min-w-0 flex-col items-stretch gap-1 py-1 pr-0', nodeClasses]">
    <div v-if="showFieldHeader" class="flex min-w-0 items-center justify-between gap-2 py-px">
      <div class="min-w-0 flex flex-1 items-center gap-1">
        <template v-if="headerEditing">
          <input
            class="input-base h-7 min-w-0 flex-1 rounded-md px-2 font-mono text-small"
            v-model="headerEditDraft"
            :placeholder="headerEditPlaceholder ?? '输入名称'"
            :disabled="disabled"
            autofocus
            @blur="onHeaderEditBlur"
            @keydown.enter.prevent="onHeaderEditEnter"
          />
        </template>
        <span v-else-if="label" class="min-w-0 flex items-center gap-1 truncate text-small leading-[1.3]" :title="node.schema.description || label">
          <span :class="[
            currentPathDirty ? 'text-text-accent' : 'text-text-secondary',
            showLocalValue ? 'font-bold' : 'font-medium'
          ]">
            {{ label }}
            <span v-if="node.schema.optional" class="ml-px text-text-subtle">?</span>
          </span>
          <span v-if="currentPathDirty" class="editor-dirty-dot" aria-hidden="true"></span>
        </span>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <span v-if="headerMeta !== undefined" class="tree-meta font-mono">{{ headerMeta }}</span>
        <button
          v-for="action in mergedHeaderActions"
          :key="action.key"
          class="flex items-center rounded-sm bg-transparent p-1 text-text-subtle hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          :class="action.danger ? 'hover:text-danger' : ''"
          :title="action.title"
          :disabled="disabled || action.disabled"
          @click.stop="onHeaderActionClick(action)"
        >
          <component :is="actionIcon(action.icon)" :size="12" :stroke-width="2" />
        </button>
      </div>
    </div>
    <SchemaField
      :schema="node.schema"
      :model-value="modelValue"
      :inherited="inherited"
      :disabled="disabled"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>

  <div v-else-if="node.kind === 'group'" :class="nodeClasses">
    <TreeNodeShell v-if="showGroupHeader" collapsible :expanded="open" :meta="headerMeta" :child-inset="false" @toggle="open = !open">
      <template #label>
        <template v-if="headerEditing">
          <input
            v-model="headerEditDraft"
            class="input-base h-7 min-w-0 flex-1 rounded-md px-2 font-mono text-small"
            :placeholder="headerEditPlaceholder ?? '输入名称'"
            :disabled="disabled"
            autofocus
            @blur="onHeaderEditBlur"
            @keydown.enter.prevent="onHeaderEditEnter"
            @click.stop
          />
        </template>
        <span v-else :class="labelClasses" :title="node.schema.description">
          {{ label }}
          <span v-if="currentPathDirty" class="editor-dirty-dot" aria-hidden="true"></span>
        </span>
      </template>
      <template #actions>
        <button
          v-for="action in mergedHeaderActions"
          :key="action.key"
          class="flex items-center rounded-sm bg-transparent p-1 text-text-subtle hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          :class="action.danger ? 'hover:text-danger' : ''"
          :title="action.title"
          :disabled="disabled || action.disabled"
          @click.stop="onHeaderActionClick(action)"
        >
          <component :is="actionIcon(action.icon)" :size="12" :stroke-width="2" />
        </button>
      </template>

      <div class="ml-1.5 border-l border-border-default pl-4">
        <SchemaNode
          v-for="(child, key) in node.children"
          :key="key"
          :node="child"
          :field-key="key"
          :model-value="asObj(modelValue)[key]"
          :inherited="childInheritedValue(key)"
          :base-value="childBaseValue(key)"
          :stored-value="childStoredValue(key)"
          :effective-value="childEffectiveValue(key)"
          :path="appendPath(key)"
          :is-layered="isLayered"
          :layer-features="layerFeatures"
          :depth="depth + 1"
          :disabled="disabled"
          @update:model-value="onGroupChildUpdate(key, $event)"
        />
      </div>
    </TreeNodeShell>

    <div v-else>
      <SchemaNode
        v-for="(child, key) in node.children"
        :key="key"
        :node="child"
        :field-key="key"
        :model-value="asObj(modelValue)[key]"
        :inherited="childInheritedValue(key)"
        :base-value="childBaseValue(key)"
        :stored-value="childStoredValue(key)"
        :effective-value="childEffectiveValue(key)"
        :path="appendPath(key)"
        :is-layered="isLayered"
        :layer-features="layerFeatures"
        :depth="depth + 1"
        :disabled="disabled"
        @update:model-value="onGroupChildUpdate(key, $event)"
      />
    </div>
  </div>

  <div v-else-if="node.kind === 'array'" :class="nodeClasses">
    <TreeNodeShell collapsible :expanded="open" :meta="headerMeta" :child-inset="false" @toggle="open = !open">
      <template #label>
        <template v-if="headerEditing">
          <input
            v-model="headerEditDraft"
            class="input-base h-7 min-w-0 flex-1 rounded-md px-2 font-mono text-small"
            :placeholder="headerEditPlaceholder ?? '输入名称'"
            :disabled="disabled"
            autofocus
            @blur="onHeaderEditBlur"
            @keydown.enter.prevent="onHeaderEditEnter"
            @click.stop
          />
        </template>
        <span v-else :class="labelClasses">
          {{ label }}
          <span v-if="currentPathDirty" class="editor-dirty-dot" aria-hidden="true"></span>
        </span>
      </template>
      <template #actions>
        <button
          v-for="action in mergedHeaderActions"
          :key="action.key"
          class="flex items-center rounded-sm bg-transparent p-1 text-text-subtle hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          :class="action.danger ? 'hover:text-danger' : ''"
          :title="action.title"
          :disabled="disabled || action.disabled"
          @click.stop="onHeaderActionClick(action)"
        >
          <component :is="actionIcon(action.icon)" :size="12" :stroke-width="2" />
        </button>
      </template>

      <div class="ml-1.5 border-l border-border-default pl-4">
        <div v-for="(item, idx) in items" :key="idx" class="py-1">
          <SchemaNode
            :node="node.item"
            :field-key="isComplexNode(node.item) ? undefined : `项目 ${idx + 1}`"
            :header-meta="`#${idx + 1}`"
            :header-actions="disabled ? [] : [
              { key: `array-up-${idx}`, icon: 'up', title: '上移', disabled: idx === 0, onClick: () => moveArrayItem(idx, -1) },
              { key: `array-down-${idx}`, icon: 'down', title: '下移', disabled: idx === items.length - 1, onClick: () => moveArrayItem(idx, 1) },
              { key: `array-copy-${idx}`, icon: 'copy', title: '复制', onClick: () => duplicateArrayItem(idx) },
              { key: `array-remove-${idx}`, icon: 'trash', title: '删除', danger: true, onClick: () => removeArrayItem(idx) }
            ]"
            :header-label="isComplexNode(node.item) ? undefined : `项目 ${idx + 1}`"
            :model-value="item"
            :inherited="inheritedArrayItem(idx)"
            :base-value="baseArrayItem(idx)"
            :stored-value="storedArrayItem(idx)"
            :effective-value="effectiveArrayItem(idx)"
            :path="appendPath(idx)"
            :is-layered="isLayered"
            :layer-features="layerFeatures"
            :depth="depth + 1"
            :disabled="disabled"
            :force-header="!isComplexNode(node.item)"
            class="min-w-0 flex-1"
            @update:model-value="onArrayItemUpdate(idx, $event)"
          />
        </div>
        <button
          v-if="!disabled"
          class="mt-1 flex cursor-pointer items-center gap-1 rounded-sm border border-dashed border-border-default bg-transparent px-2 py-0.75 text-small text-text-muted hover:border-text-muted hover:text-text-primary"
          @click="addArrayItem"
        >
          <Plus :size="12" :stroke-width="2" /> 添加
        </button>
      </div>
    </TreeNodeShell>
  </div>

  <div v-else-if="node.kind === 'record'" :class="nodeClasses">
    <TreeNodeShell collapsible :expanded="open" :meta="headerMeta" :child-inset="false" @toggle="open = !open">
      <template #label>
        <template v-if="headerEditing">
          <input
            v-model="headerEditDraft"
            class="input-base h-7 min-w-0 flex-1 rounded-md px-2 font-mono text-small"
            :placeholder="headerEditPlaceholder ?? '输入名称'"
            :disabled="disabled"
            autofocus
            @blur="onHeaderEditBlur"
            @keydown.enter.prevent="onHeaderEditEnter"
            @click.stop
          />
        </template>
        <span v-else :class="labelClasses">
          {{ label }}
          <span v-if="currentPathDirty" class="editor-dirty-dot" aria-hidden="true"></span>
        </span>
      </template>
      <template #actions>
        <button
          v-for="action in mergedHeaderActions"
          :key="action.key"
          class="flex items-center rounded-sm bg-transparent p-1 text-text-subtle hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          :class="action.danger ? 'hover:text-danger' : ''"
          :title="action.title"
          :disabled="disabled || action.disabled"
          @click.stop="onHeaderActionClick(action)"
        >
          <component :is="actionIcon(action.icon)" :size="12" :stroke-width="2" />
        </button>
      </template>

      <div class="ml-1.5 border-l border-border-default pl-4">
        <div v-for="([key, value], idx) in recordEntries" :key="key" class="py-1">
          <SchemaNode
            :node="node.value"
            :field-key="isComplexNode(node.value) ? undefined : key"
            :header-label="key"
            :header-editing="editingRecordKey === key"
            :header-edit-value="key"
            :header-edit-placeholder="'输入 key'"
            :header-actions="disabled ? [] : recordHeaderActions(key, idx)"
            :model-value="value"
            :inherited="inheritedRecordValue(key)"
            :base-value="baseRecordValue(key)"
            :stored-value="storedRecordValue(key)"
            :effective-value="effectiveRecordValue(key)"
            :path="appendPath(key)"
            :is-layered="isLayered"
            :layer-features="layerFeatures"
            :depth="depth + 1"
            :disabled="disabled"
            :force-header="true"
            :on-header-edit-submit="(rawKey: string) => { renameRecordKey(key, rawKey); editingRecordKey = null; }"
            class="min-w-0 flex-1"
            @update:model-value="onRecordValueUpdate(key, $event)"
          />
        </div>
        <button
          v-if="!disabled"
          class="mt-1 flex cursor-pointer items-center gap-1 rounded-sm border border-dashed border-border-default bg-transparent px-2 py-0.75 text-small text-text-muted hover:border-text-muted hover:text-text-primary"
          @click="addRecordEntry"
        >
          <Plus :size="12" :stroke-width="2" /> 添加
        </button>
      </div>
    </TreeNodeShell>
  </div>

  <div v-else-if="node.kind === 'union'" :class="nodeClasses">
    <div class="flex flex-col items-stretch gap-1 py-1">
      <span class="text-small leading-[1.3] text-text-muted">{{ label }}</span>
      <select class="input-base min-h-6 max-w-60 px-1.5 py-0.5 text-small" :value="selectedUnionIdx" :disabled="disabled" @change="onUnionSelect">
        <option v-for="(opt, idx) in unionOptions" :key="idx" :value="idx">
          {{ getUnionOptionLabel(opt, idx) }}
        </option>
      </select>
    </div>
    <SchemaNode
      v-if="unionOptions[selectedUnionIdx]"
      :node="unionOptions[selectedUnionIdx]!"
      :model-value="modelValue"
      :inherited="inherited"
      :base-value="baseValue"
      :stored-value="storedValue"
      :effective-value="effectiveValue"
      :path="path"
      :is-layered="isLayered"
      :layer-features="layerFeatures"
      :depth="depth + 1"
      :disabled="disabled"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>
