<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { Plus, Trash2, ArrowUp, ArrowDown, Pencil, Check, Undo2, Copy } from "lucide-vue-next";
import SchemaField from "./SchemaField.vue";
import { TreeNodeShell } from "@workbench-kit/vue-workbench";
import type { EditorFeatures, UiNode } from "../types";
import { canUnsetNodeValue, deepEqual, removeValueAtPathAndPrune, type PathSegment } from "../editorState";

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
  /** 当前节点的 UI tree。 */
  node: UiNode;
  /** 当前节点在父对象中的 key，用于标题和路径展示。 */
  fieldKey?: string;
  /** 当前节点的草稿值。 */
  modelValue: unknown;
  /** 参考层或继承值，用于显示 reference backdrop。 */
  inherited?: unknown;
  /** schema 默认值，用于当前层和参考层都未定义时展示。 */
  defaultValue?: unknown;
  /** 已保存的当前层值，用于 dirty 判断。 */
  storedValue?: unknown;
  /** 最终生效值。 */
  effectiveValue?: unknown;
  /** 当前节点路径。根节点可省略。 */
  path?: PathSegment[];
  /** 后端返回的编辑器功能开关。 */
  editorFeatures?: EditorFeatures;
  /** 当前递归深度。 */
  depth?: number;
  /** true 时禁用本节点及子节点编辑。 */
  disabled?: boolean;
  /** true 时按浏览视图展示本节点及子节点，不渲染可编辑控件。 */
  readOnly?: boolean;
  headerLabel?: string;
  headerDescription?: string;
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
const interactionsDisabled = computed(() => props.disabled || props.readOnly);

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
const description = computed(() => props.headerDescription ?? props.node.schema.description);
const headerMeta = computed(() => {
  if (props.headerMeta !== undefined) {
    return props.headerMeta;
  }
  if (props.node.kind === "array") {
    return displayedItems.value.length;
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

function childDefaultValue(key: string): unknown {
  return asObj(props.defaultValue)[key];
}

function childStoredValue(key: string): unknown {
  return asObj(props.storedValue)[key];
}

function childEffectiveValue(key: string): unknown {
  return asObj(props.effectiveValue)[key];
}

const currentPathDirty = computed(() => !props.readOnly && !deepEqual(props.modelValue, props.storedValue));
const showReferenceTone = computed(() => !props.readOnly && !!props.editorFeatures?.showReferenceBackdrop);
const canUnsetCurrentValue = computed(() =>
  canUnsetNodeValue({
    unsetMode: props.editorFeatures?.unsetMode ?? "disabled",
    schemaOptional: props.node.schema.optional,
    path: path.value,
    modelValue: props.modelValue
  })
);
const showLocalValue = computed(() =>
  showReferenceTone.value
  && path.value.length > 0
  && props.modelValue !== undefined
);

function unsetCurrentValue() {
  const next = removeValueAtPathAndPrune(props.modelValue, []);
  emit("update:modelValue", next);
}

const unsetActionTitle = computed(() => {
  if (
    props.editorFeatures?.unsetActionLabel
    && (props.inherited !== undefined || props.editorFeatures.showReferenceBackdrop)
  ) {
    return props.editorFeatures.unsetActionLabel;
  }
  return "删除此项";
});

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
  if (canUnsetCurrentValue.value && !interactionsDisabled.value) {
    next.unshift({
      key: `unset-${path.value.join(".") || "root"}`,
      icon: "restore",
      title: unsetActionTitle.value,
      onClick: unsetCurrentValue
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
const defaultItems = computed(() => asArr(props.defaultValue));
const storedItems = computed(() => asArr(props.storedValue));
const effectiveItems = computed(() => asArr(props.effectiveValue));
const displayedItems = computed(() => props.modelValue !== undefined ? items.value : effectiveItems.value);

function isComplexNode(node: UiNode): boolean {
  return node.kind !== "field";
}

const editingRecordKey = ref<string | null>(null);

function inheritedArrayItem(index: number): unknown {
  return inheritedItems.value[index];
}

function defaultArrayItem(index: number): unknown {
  return defaultItems.value[index];
}

function storedArrayItem(index: number): unknown {
  return storedItems.value[index];
}

function effectiveArrayItem(index: number): unknown {
  return effectiveItems.value[index];
}

function onArrayItemUpdate(index: number, childValue: unknown) {
  const next = [...displayedItems.value];
  next[index] = childValue;
  emit("update:modelValue", next);
}

function addArrayItem() {
  emit("update:modelValue", [...displayedItems.value, null]);
}

function removeArrayItem(index: number) {
  const next = [...displayedItems.value];
  next.splice(index, 1);
  emit("update:modelValue", next.length > 0 ? next : undefined);
}

function moveArrayItem(index: number, offset: -1 | 1) {
  const targetIndex = index + offset;
  if (targetIndex < 0 || targetIndex >= displayedItems.value.length) return;
  const next = [...displayedItems.value];
  const [entry] = next.splice(index, 1);
  next.splice(targetIndex, 0, entry);
  emit("update:modelValue", next);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function duplicateArrayItem(index: number) {
  const next = [...displayedItems.value];
  const copy = jsonClone(next[index]);
  next.splice(index + 1, 0, copy);
  emit("update:modelValue", next);
}

const displayedRecord = computed(() => props.modelValue !== undefined ? asObj(props.modelValue) : asObj(props.effectiveValue));
const recordEntries = computed(() => Object.entries(displayedRecord.value));
const inheritedRecord = computed(() => asObj(props.inherited));
const defaultRecord = computed(() => asObj(props.defaultValue));
const storedRecord = computed(() => asObj(props.storedValue));
const effectiveRecord = computed(() => asObj(props.effectiveValue));

function inheritedRecordValue(key: string): unknown {
  return inheritedRecord.value[key];
}

function defaultRecordValue(key: string): unknown {
  return defaultRecord.value[key];
}

function storedRecordValue(key: string): unknown {
  return storedRecord.value[key];
}

function effectiveRecordValue(key: string): unknown {
  return effectiveRecord.value[key];
}

function onRecordValueUpdate(key: string, childValue: unknown) {
  const next = cloneRecord(displayedRecord.value);
  if (childValue === undefined) {
    delete next[key];
  } else {
    next[key] = childValue;
  }
  emitObjectWithoutUndefined(next);
}

function addRecordEntry() {
  const next = cloneRecord(displayedRecord.value);
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
  const next = cloneRecord(displayedRecord.value);
  delete next[key];
  emitObjectWithoutUndefined(next);
}

function duplicateRecordEntry(key: string) {
  const next = cloneRecord(displayedRecord.value);
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
const displayedUnionValue = computed(() =>
  props.modelValue !== undefined
    ? props.modelValue
    : props.effectiveValue !== undefined
      ? props.effectiveValue
      : props.defaultValue
);
const matchedUnionIdx = computed(() => unionOptions.value.findIndex((option) => nodeMatchesValue(option, displayedUnionValue.value)));
const activeUnionIdx = computed(() => {
  if (props.readOnly) {
    return matchedUnionIdx.value >= 0 ? matchedUnionIdx.value : 0;
  }
  return selectedUnionIdx.value;
});

watch(
  () => [unionOptions.value.length, matchedUnionIdx.value] as const,
  ([optionCount, matchedIdx]) => {
    if (optionCount === 0) {
      selectedUnionIdx.value = 0;
      return;
    }
    if (selectedUnionIdx.value >= optionCount) {
      selectedUnionIdx.value = 0;
    }
    if (selectedUnionIdx.value === 0 && matchedIdx > 0) {
      selectedUnionIdx.value = matchedIdx;
    }
  },
  { immediate: true }
);

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
      const label = getLeafLiteralLabel(child.node);
      if (label) return label;
    }
  }

  return `选项 ${index + 1}`;
}

function nodeMatchesValue(node: UiNode, value: unknown): boolean {
  switch (node.kind) {
    case "field":
      return fieldSchemaMatchesValue(node, value);
    case "group":
      return groupNodeMatchesValue(node, value);
    case "array":
      return Array.isArray(value);
    case "record":
      return isPlainObject(value);
    case "union":
      return node.options.some((option) => nodeMatchesValue(option, value));
  }
}

function fieldSchemaMatchesValue(node: Extract<UiNode, { kind: "field" }>, value: unknown): boolean {
  switch (node.schema.kind) {
    case "literal":
      return value === node.schema.value;
    case "enum":
      return node.schema.values?.includes(value as never) ?? false;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

function groupNodeMatchesValue(node: Extract<UiNode, { kind: "group" }>, value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const discriminantChildren = Object.entries(node.children)
    .filter(([, child]) => getLeafLiteralLabel(child.node) !== null);
  if (discriminantChildren.length === 0) return true;
  return discriminantChildren.every(([key, child]) => nodeMatchesValue(child.node, value[key]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
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
            :disabled="interactionsDisabled"
            autofocus
            @blur="onHeaderEditBlur"
            @keydown.enter.prevent="onHeaderEditEnter"
          />
        </template>
        <span v-else-if="label" class="min-w-0 flex items-center gap-1 truncate text-small leading-[1.3]" :title="description || label">
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
          :disabled="interactionsDisabled || action.disabled"
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
      :default-value="defaultValue"
      :disabled="disabled"
      :read-only="readOnly"
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
            :disabled="interactionsDisabled"
            autofocus
            @blur="onHeaderEditBlur"
            @keydown.enter.prevent="onHeaderEditEnter"
            @click.stop
          />
        </template>
        <span v-else :class="labelClasses" :title="description">
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
          :disabled="interactionsDisabled || action.disabled"
          @click.stop="onHeaderActionClick(action)"
        >
          <component :is="actionIcon(action.icon)" :size="12" :stroke-width="2" />
        </button>
      </template>

      <div class="ml-1.5 border-l border-border-default pl-4">
        <SchemaNode
          v-for="(child, key) in node.children"
          :key="key"
          :node="child.node"
          :field-key="key"
          :header-label="child.field.title"
          :header-description="child.field.description"
          :model-value="asObj(modelValue)[key]"
          :inherited="childInheritedValue(key)"
          :default-value="childDefaultValue(key)"
          :stored-value="childStoredValue(key)"
          :effective-value="childEffectiveValue(key)"
          :path="appendPath(key)"
          :editor-features="editorFeatures"
          :depth="depth + 1"
          :disabled="disabled"
          :read-only="readOnly"
          @update:model-value="onGroupChildUpdate(key, $event)"
        />
      </div>
    </TreeNodeShell>

    <div v-else>
      <SchemaNode
        v-for="(child, key) in node.children"
        :key="key"
        :node="child.node"
        :field-key="key"
        :header-label="child.field.title"
        :header-description="child.field.description"
        :model-value="asObj(modelValue)[key]"
        :inherited="childInheritedValue(key)"
        :default-value="childDefaultValue(key)"
        :stored-value="childStoredValue(key)"
        :effective-value="childEffectiveValue(key)"
        :path="appendPath(key)"
        :editor-features="editorFeatures"
        :depth="depth + 1"
        :disabled="disabled"
        :read-only="readOnly"
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
            :disabled="interactionsDisabled"
            autofocus
            @blur="onHeaderEditBlur"
            @keydown.enter.prevent="onHeaderEditEnter"
            @click.stop
          />
        </template>
        <span v-else :class="labelClasses" :title="description">
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
          :disabled="interactionsDisabled || action.disabled"
          @click.stop="onHeaderActionClick(action)"
        >
          <component :is="actionIcon(action.icon)" :size="12" :stroke-width="2" />
        </button>
      </template>

      <div class="ml-1.5 border-l border-border-default pl-4">
        <div v-for="(item, idx) in displayedItems" :key="idx" class="py-1">
          <SchemaNode
            :node="node.item"
            :field-key="isComplexNode(node.item) ? undefined : `项目 ${idx + 1}`"
            :header-meta="`#${idx + 1}`"
            :header-actions="interactionsDisabled ? [] : [
              { key: `array-up-${idx}`, icon: 'up', title: '上移', disabled: idx === 0, onClick: () => moveArrayItem(idx, -1) },
              { key: `array-down-${idx}`, icon: 'down', title: '下移', disabled: idx === displayedItems.length - 1, onClick: () => moveArrayItem(idx, 1) },
              { key: `array-copy-${idx}`, icon: 'copy', title: '复制', onClick: () => duplicateArrayItem(idx) },
              { key: `array-remove-${idx}`, icon: 'trash', title: '删除', danger: true, onClick: () => removeArrayItem(idx) }
            ]"
            :header-label="isComplexNode(node.item) ? undefined : `项目 ${idx + 1}`"
            :model-value="items[idx]"
            :inherited="inheritedArrayItem(idx)"
            :default-value="defaultArrayItem(idx)"
            :stored-value="storedArrayItem(idx)"
            :effective-value="effectiveArrayItem(idx)"
            :path="appendPath(idx)"
            :editor-features="editorFeatures"
            :depth="depth + 1"
            :disabled="disabled"
            :read-only="readOnly"
            :force-header="!isComplexNode(node.item)"
            class="min-w-0 flex-1"
            @update:model-value="onArrayItemUpdate(idx, $event)"
          />
        </div>
        <button
          v-if="!interactionsDisabled"
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
            :disabled="interactionsDisabled"
            autofocus
            @blur="onHeaderEditBlur"
            @keydown.enter.prevent="onHeaderEditEnter"
            @click.stop
          />
        </template>
        <span v-else :class="labelClasses" :title="description">
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
          :disabled="interactionsDisabled || action.disabled"
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
            :header-actions="interactionsDisabled ? [] : recordHeaderActions(key, idx)"
            :model-value="asObj(modelValue)[key]"
            :inherited="inheritedRecordValue(key)"
            :default-value="defaultRecordValue(key)"
            :stored-value="storedRecordValue(key)"
            :effective-value="effectiveRecordValue(key)"
            :path="appendPath(key)"
            :editor-features="editorFeatures"
            :depth="depth + 1"
            :disabled="disabled"
            :read-only="readOnly"
            :force-header="true"
            :on-header-edit-submit="(rawKey: string) => { renameRecordKey(key, rawKey); editingRecordKey = null; }"
            class="min-w-0 flex-1"
            @update:model-value="onRecordValueUpdate(key, $event)"
          />
        </div>
        <button
          v-if="!interactionsDisabled"
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
      <select class="input-base min-h-6 max-w-60 px-1.5 py-0.5 text-small" :value="activeUnionIdx" :disabled="interactionsDisabled" @change="onUnionSelect">
        <option v-for="(opt, idx) in unionOptions" :key="idx" :value="idx">
          {{ getUnionOptionLabel(opt, idx) }}
        </option>
      </select>
    </div>
    <SchemaNode
      v-if="unionOptions[activeUnionIdx]"
      :node="unionOptions[activeUnionIdx]!"
      :model-value="modelValue"
      :inherited="inherited"
      :default-value="defaultValue"
      :stored-value="storedValue"
      :effective-value="effectiveValue"
      :path="path"
      :editor-features="editorFeatures"
      :depth="depth + 1"
      :disabled="disabled"
      :read-only="readOnly"
      @update:model-value="emit('update:modelValue', $event)"
    />
  </div>
</template>
