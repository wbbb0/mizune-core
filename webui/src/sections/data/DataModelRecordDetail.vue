<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from "vue";
import { Save, Table2, Trash2 } from "lucide-vue-next";
import { SchemaNode, type UiNode } from "@workbench-kit/vue-resource-editor";
import { dataApi, type DataResource } from "@/api/data";
import { useElementWidth } from "@/composables/useElementWidth";
import { useDataSection } from "@/composables/sections/useDataSection";
import { useWorkbenchToasts, useWorkbenchWindows } from "@workbench-kit/vue-workbench";
import { formatModelCell, getModelDetailEntries, modelRowId, rowText } from "./dataModelView";
import DataJsonValueViewer from "./DataJsonValueViewer.vue";

const DataModelDrilldownPane = defineAsyncComponent(() => import("./DataModelDrilldownPane.vue"));
type DataModelChild = NonNullable<NonNullable<DataResource["model"]>["children"]>[number];

const props = defineProps<{
  resource: DataResource;
  row: Record<string, unknown>;
  windowId?: string;
}>();

const windows = useWorkbenchWindows();
const toast = useWorkbenchToasts();
const {
  saving,
  getRegistryExistingRowDraft,
  updateRegistryExistingRowDraft,
  canSaveRegistryRow,
  saveRegistryRow,
  deleteRegistryRow
} = useDataSection();
const paneRef = ref<HTMLElement | null>(null);
const paneWidth = useElementWidth(paneRef);
const compactPane = computed(() => paneWidth.value > 0 && paneWidth.value < 520);
const detailEntries = computed(() => getModelDetailEntries(props.resource, props.row));
const childLoadingKey = ref<string | null>(null);
const patchable = computed(() =>
  props.resource.shape === "collection"
  && props.resource.editable
  && props.resource.rowOperations?.patch === true
  && !!props.resource.rowUiTree
);
const deletable = computed(() =>
  props.resource.shape === "collection"
  && props.resource.editable
  && props.resource.rowOperations?.delete === true
);

function formatTime(ms: number | undefined): string {
  if (ms == null) return "-";
  return new Date(ms).toLocaleString("zh-CN");
}

function formatDetailValue(value: unknown, type: string | undefined): string {
  return formatModelCell(value, type, formatTime);
}

function getRowFieldNode(key: string): UiNode | undefined {
  const tree = props.resource.rowUiTree;
  if (tree?.kind !== "group") return undefined;
  return tree.children[key]?.node;
}

function childButtonLabel(child: DataModelChild): string {
  return child.title || child.resourceKey;
}

async function openChild(child: DataModelChild) {
  const parentValue = props.row[child.parentField];
  if (parentValue == null || childLoadingKey.value) {
    return;
  }
  childLoadingKey.value = child.resourceKey;
  try {
    const filters = { [child.childField]: parentValue };
    const [resourceResponse, rows] = await Promise.all([
      dataApi.get(child.resourceKey),
      dataApi.listRows(child.resourceKey, {
        limit: 50,
        filters
      })
    ]);
    windows.openDialogSync({
      ...(props.windowId ? { kind: "child-dialog" as const, parentId: props.windowId } : { kind: "dialog" as const }),
      title: childButtonLabel(child),
      description: `${props.resource.title} / ${rowText(props.row[child.parentField])}`,
      size: "xl",
      footer: "hidden",
      modal: false,
      showCloseButton: true,
      closeOnBackdrop: false,
      closeOnEscape: true,
      context: {
        kind: "data-model-child",
        id: `${props.resource.key}:${modelRowId(props.row, props.resource)}:${child.resourceKey}`
      },
      blocks: [{
        kind: "component",
        component: DataModelDrilldownPane,
        props: {
          resource: resourceResponse.resource,
          rowsResult: rows,
          filters
        }
      }]
    });
  } catch (error: unknown) {
    toast.push({ type: "error", message: error instanceof Error ? error.message : "读取子表失败" });
  } finally {
    childLoadingKey.value = null;
  }
}
</script>

<template>
  <div ref="paneRef" class="flex min-h-0 flex-col">
    <section class="border-b border-border-default px-4 py-3">
      <div class="mb-2 flex items-center gap-2">
        <div class="min-w-0 flex-1 text-small font-medium text-text-secondary">{{ patchable ? "编辑" : "详情" }}</div>
        <button
          v-if="patchable"
          class="btn-ghost"
          :disabled="!canSaveRegistryRow(row)"
          title="保存"
          @click="saveRegistryRow(row)"
        >
          <Save :size="13" :stroke-width="1.5" />
        </button>
        <button
          v-if="deletable"
          class="btn-ghost"
          :disabled="saving"
          title="删除"
          @click="deleteRegistryRow(row)"
        >
          <Trash2 :size="13" :stroke-width="2" />
        </button>
      </div>
      <SchemaNode
        v-if="patchable && resource.rowUiTree"
        :node="resource.rowUiTree"
        :model-value="getRegistryExistingRowDraft(row)"
        :stored-value="row"
        :effective-value="getRegistryExistingRowDraft(row)"
        :depth="0"
        @update:model-value="updateRegistryExistingRowDraft(row, $event)"
      />
      <dl v-else class="grid gap-x-3 gap-y-2 text-small" :class="compactPane ? 'grid-cols-1' : 'grid-cols-[8rem_minmax(0,1fr)]'">
        <template v-for="entry in detailEntries" :key="entry.column.key">
          <dt class="font-mono text-text-subtle">{{ entry.column.title || entry.column.key }}</dt>
          <dd v-if="entry.column.type === 'json'" class="min-w-0">
            <DataJsonValueViewer :value="entry.value" :node="getRowFieldNode(entry.column.key)" />
          </dd>
          <dd v-else class="min-w-0 truncate font-mono text-text-primary" :title="formatDetailValue(entry.value, entry.column.type)">
            {{ formatDetailValue(entry.value, entry.column.type) }}
          </dd>
        </template>
      </dl>
    </section>

    <section v-if="resource.model?.children?.length" class="px-4 py-3">
      <div class="mb-2 text-small font-medium text-text-secondary">子表</div>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="child in resource.model.children"
          :key="child.resourceKey"
          class="btn btn-secondary"
          :disabled="childLoadingKey !== null || row[child.parentField] == null"
          @click="openChild(child)"
        >
          <Table2 :size="13" :stroke-width="2" />
          {{ childButtonLabel(child) }}
        </button>
      </div>
    </section>
  </div>
</template>
