<script setup lang="ts">
import { ref, watch, onMounted, computed } from "vue";
import { RefreshCw, ChevronRight, ChevronDown, Save, CheckCircle, AlertCircle } from "lucide-vue-next";
import AppLayout from "@/components/layout/AppLayout.vue";
import SchemaNode from "@/components/editor/SchemaNode.vue";
import { dataApi, type DataResourceSummary, type DataResource, type DataResourceItem, type DirectoryItem } from "@/api/data";
import { editorApi, type EditorResourceSummary, type EditorModel, type LayeredEditorModel, type SingleEditorModel } from "@/api/editor";
import { useLayeredEditorState } from "@/composables/useLayeredEditorState";
import { useUiStore } from "@/stores/ui";

type DataListResource =
  | {
      key: string;
      title: string;
      source: "browser";
      kind: DataResourceSummary["kind"];
      editable: false;
    }
  | {
      key: string;
      title: string;
      source: "editor";
      kind: EditorResourceSummary["kind"];
      editable: boolean;
    };


const ui = useUiStore();
const layout = ref<InstanceType<typeof AppLayout> | null>(null);
const resources = ref<DataListResource[]>([]);
const selectedKey = ref<string | null>(null);
const resource = ref<DataResource | null>(null);
const model = ref<EditorModel | null>(null);
const itemDetail = ref<DataResourceItem | null>(null);
const selectedItemKey = ref<string | null>(null);
const loading = ref(false);
const loadingItem = ref(false);
const saving = ref(false);
const validating = ref(false);
const saveMsg = ref<{ ok: boolean; text: string } | null>(null);
const {
  draftValue,
  isLayered,
  baseValue,
  storedDraftValue,
  effectiveValue,
  isDirty
} = useLayeredEditorState(model);
const canSubmit = computed(() => !!selectedResource.value?.editable && isDirty.value && !validating.value && !saving.value);

const selectedResource = computed(() =>
  resources.value.find((entry) => entry.key === selectedKey.value) ?? null
);

const formattedJson = computed(() => {
  if (!resource.value || resource.value.kind !== "single_json") return "";
  return JSON.stringify(resource.value.value, null, 2);
});

const formattedItemJson = computed(() =>
  itemDetail.value ? JSON.stringify(itemDetail.value.value, null, 2) : ""
);

const mobileHeaderTitle = computed(() => {
  if (selectedResource.value?.source === "editor" && model.value) {
    return model.value.title;
  }
  if (selectedResource.value?.source === "browser" && resource.value) {
    if (resource.value.kind === "directory_json" && itemDetail.value) {
      return itemDetail.value.title || itemDetail.value.key;
    }
    return resource.value.title;
  }
  return "";
});

onMounted(async () => {
  const [dataRes, editorRes] = await Promise.all([dataApi.list(), editorApi.list()]);
  resources.value = [
    ...editorRes.resources
      .filter((entry) => entry.domain === "data")
      .map((entry) => ({
        key: entry.key,
        title: entry.title,
        source: "editor" as const,
        kind: entry.kind,
        editable: entry.editable
      })),
    ...dataRes.resources.map((entry) => ({
      key: entry.key,
      title: entry.title,
      source: "browser" as const,
      kind: entry.kind,
      editable: false as const
    }))
  ].sort((left, right) => left.key.localeCompare(right.key));
});

watch(selectedKey, async (key) => {
  resource.value = null;
  model.value = null;
  itemDetail.value = null;
  selectedItemKey.value = null;
  saveMsg.value = null;
  if (!key) return;

  const target = resources.value.find((entry) => entry.key === key);
  if (!target) return;

  loading.value = true;
  try {
    if (target.source === "browser") {
      const res = await dataApi.get(key);
      resource.value = res.resource;
      return;
    }

    const res = await editorApi.load(key);
    model.value = res.editor;
  } finally {
    loading.value = false;
  }
});

watch(selectedItemKey, async (itemKey) => {
  itemDetail.value = null;
  if (!itemKey || !selectedKey.value || selectedResource.value?.source !== "browser") return;
  loadingItem.value = true;
  try {
    const res = await dataApi.getItem(selectedKey.value, itemKey);
    itemDetail.value = res.item;
  } finally {
    loadingItem.value = false;
  }
});

function selectResource(key: string) {
  selectedKey.value = key;
  layout.value?.openDetail();
}

function selectDirectoryItem(key: string) {
  selectedItemKey.value = key;
  layout.value?.openDetail();
}

async function refreshSelected() {
  if (!selectedKey.value || !selectedResource.value) return;
  loading.value = true;
  try {
    if (selectedResource.value.source === "browser") {
      const res = await dataApi.get(selectedKey.value);
      resource.value = res.resource;
      return;
    }

    const res = await editorApi.load(selectedKey.value);
    model.value = res.editor;
  } finally {
    loading.value = false;
  }
}

async function reloadFromServer() {
  if (!selectedKey.value || !model.value || loading.value || saving.value || validating.value) return;
  loading.value = true;
  saveMsg.value = null;
  try {
    const res = await editorApi.load(selectedKey.value);
    model.value = res.editor;
  } finally {
    loading.value = false;
  }
}

async function validate() {
  if (!selectedKey.value || !model.value || !canSubmit.value) return;
  validating.value = true;
  saveMsg.value = null;
  try {
    await editorApi.validate(selectedKey.value, draftValue.value);
    saveMsg.value = { ok: true, text: "验证通过" };
  } catch (error: unknown) {
    saveMsg.value = { ok: false, text: error instanceof Error ? error.message : "验证失败" };
  } finally {
    validating.value = false;
  }
}

async function save() {
  if (!selectedKey.value || !model.value || !canSubmit.value) return;
  saving.value = true;
  saveMsg.value = null;
  try {
    const res = await editorApi.save(selectedKey.value, draftValue.value);
    saveMsg.value = { ok: true, text: `已保存 → ${res.path}` };
    await refreshSelected();
  } catch (error: unknown) {
    saveMsg.value = { ok: false, text: error instanceof Error ? error.message : "保存失败" };
  } finally {
    saving.value = false;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN");
}

function resourceBadge(resourceEntry: DataListResource): string {
  if (resourceEntry.source === "editor") {
    if (!resourceEntry.editable) return "只读";
    return resourceEntry.kind === "layered" ? "编辑器" : "JSON";
  }
  return resourceEntry.kind === "directory_json" ? "目录" : "JSON";
}

function updateDraft(value: unknown) {
  draftValue.value = value;
}
</script>

<template>
  <AppLayout ref="layout">
    <template #side>
      <div v-if="!ui.isMobile" class="panel-header flex h-10 shrink-0 items-center border-b px-3">
        <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">数据</span>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <button
          v-for="entry in resources"
          :key="entry.key"
          class="list-row flex w-full items-center justify-between px-3 py-1.75 text-left"
          :class="{ 'is-selected': selectedKey === entry.key }"
          @click="selectResource(entry.key)"
        >
          <span class="text-ui text-text-secondary">{{ entry.title }}</span>
          <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ resourceBadge(entry) }}</span>
        </button>
        <div v-if="resources.length === 0" class="px-3 py-6 text-center text-small text-text-subtle">暂无数据资源</div>
      </div>
    </template>

    <template #main>
      <div class="flex h-full flex-col overflow-hidden">
        <div v-if="!selectedKey" class="panel-empty flex flex-1 items-center justify-center gap-2">← 选择一个数据资源</div>

        <div v-else-if="loading" class="panel-empty flex flex-1 items-center justify-center gap-2">
          <RefreshCw :size="16" class="spin" :stroke-width="2" />
          <span>加载中…</span>
        </div>

        <template v-else-if="selectedResource?.source === 'editor' && model">
          <header class="toolbar-header flex h-10 shrink-0 flex-wrap items-center gap-2.5 border-b px-4 py-1.5">
            <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ model.kind }}</span>
            <template v-if="model.kind === 'layered'">
              <span class="text-small text-text-muted">层次：</span>
              <span
                v-for="layer in (model as LayeredEditorModel).layers"
                :key="layer.key"
                class="rounded-full bg-surface-muted px-2 py-0.5 text-small text-text-muted"
                :class="{ 'bg-accent text-text-on-accent': layer.key === (model as LayeredEditorModel).writableLayerKey }"
              >{{ layer.key }}</span>
            </template>
            <div class="ml-auto flex gap-1.5">
              <button class="btn btn-secondary" :disabled="loading || saving || validating || !model" @click="reloadFromServer">
                <RefreshCw :size="13" :stroke-width="2" />
                重新读取
              </button>
              <button class="btn btn-secondary" :disabled="!canSubmit" @click="validate">
                <RefreshCw v-if="validating" :size="13" class="spin" :stroke-width="2" />
                验证
              </button>
              <button class="btn btn-primary" :disabled="!canSubmit" @click="save">
                <Save :size="13" :stroke-width="1.5" />
                {{ saving ? "保存中…" : "保存" }}
              </button>
            </div>
          </header>

          <div
            v-if="saveMsg"
            class="mx-4 mt-3 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-small"
            :class="saveMsg.ok ? 'bg-surface-success text-success' : 'bg-surface-danger text-danger'"
          >
            <CheckCircle v-if="saveMsg.ok" :size="13" :stroke-width="2" />
            <AlertCircle v-else :size="13" :stroke-width="2" />
            {{ saveMsg.text }}
          </div>

          <div class="scrollbar-thin flex-1 overflow-y-auto px-4 py-3">
            <SchemaNode
              :node="model.uiTree"
              :model-value="draftValue"
              :inherited="model.kind === 'layered' ? baseValue : (model as SingleEditorModel).current"
              :base-value="isLayered ? baseValue : undefined"
              :stored-value="storedDraftValue"
              :effective-value="effectiveValue"
              :layer-features="model.kind === 'layered' ? (model as LayeredEditorModel).layerFeatures : undefined"
              :is-layered="isLayered"
              :depth="0"
              @update:model-value="updateDraft"
            />
          </div>
        </template>

        <template v-else-if="selectedResource?.source === 'browser' && resource">
          <header class="toolbar-header flex h-10 shrink-0 items-center gap-2.5 overflow-hidden border-b px-4">
            <span class="truncate font-mono text-small text-text-subtle">{{ resource.path }}</span>
            <button class="btn-ghost ml-auto" :disabled="loading" @click="refreshSelected">
              <RefreshCw :size="13" :stroke-width="2" :class="{ spin: loading }" />
            </button>
          </header>

          <div v-if="resource.kind === 'single_json'" class="scrollbar-thin flex-1 overflow-auto px-4 py-3">
            <pre class="m-0 overflow-auto p-0 font-mono text-mono leading-6 text-text-primary whitespace-pre">{{ formattedJson }}</pre>
          </div>

          <div v-else class="flex min-h-0 flex-1 overflow-hidden">
            <div class="scrollbar-thin w-55 shrink-0 overflow-y-auto border-r border-border-default">
              <button
                v-for="item in (resource.items as DirectoryItem[])"
                :key="item.key"
                class="list-row flex w-full flex-col gap-0.5 px-3 py-1.5 text-left"
                :class="{ 'is-selected': selectedItemKey === item.key }"
                @click="selectDirectoryItem(item.key)"
              >
                <div class="tree-head">
                  <component
                    :is="selectedItemKey === item.key ? ChevronDown : ChevronRight"
                    :size="13"
                    :stroke-width="2"
                    class="tree-chevron"
                  />
                  <span class="tree-label font-mono text-small">{{ item.title || item.key }}</span>
                </div>
                <div class="flex min-w-0 gap-2 pl-4.25">
                  <span class="tree-meta">{{ formatSize(item.size) }}</span>
                  <span class="tree-meta">{{ formatTime(item.updatedAt) }}</span>
                </div>
              </button>
              <div v-if="resource.items.length === 0" class="px-3 py-6 text-center text-small text-text-subtle">目录为空</div>
            </div>

            <div class="scrollbar-thin flex flex-1 flex-col overflow-auto">
              <div v-if="!selectedItemKey" class="panel-empty flex flex-1 items-center justify-center gap-2">← 选择一个文件</div>
              <div v-else-if="loadingItem" class="panel-empty flex flex-1 items-center justify-center gap-2">
                <RefreshCw :size="14" class="spin" :stroke-width="2" />
              </div>
              <template v-else-if="itemDetail">
                <div class="toolbar-header flex shrink-0 items-center gap-3 border-b px-4 py-1.5">
                  <span class="flex-1 truncate font-mono text-small text-text-muted">{{ itemDetail.path }}</span>
                  <span class="shrink-0 text-small text-text-subtle">{{ formatSize(itemDetail.size) }}</span>
                  <span class="shrink-0 text-small text-text-subtle">{{ formatTime(itemDetail.updatedAt) }}</span>
                </div>
                <pre class="m-0 overflow-auto px-4 py-3 font-mono text-mono leading-6 text-text-primary whitespace-pre">{{ formattedItemJson }}</pre>
              </template>
            </div>
          </div>
        </template>
      </div>
    </template>

    <template #mobile-header>
      <span v-if="mobileHeaderTitle" class="truncate text-ui font-medium text-text-secondary">{{ mobileHeaderTitle }}</span>
    </template>
  </AppLayout>
</template>
