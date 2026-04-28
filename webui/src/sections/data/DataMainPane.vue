<script setup lang="ts">
import { RefreshCw, ChevronRight, ChevronDown, Save } from "lucide-vue-next";
import SchemaNode from "@/components/editor/SchemaNode.vue";
import { useDataSection } from "@/composables/sections/useDataSection";
import type { DirectoryItem } from "@/api/data";
import { WorkbenchAreaHeader, WorkbenchEmptyState, WorkbenchListItem } from "@/components/workbench/primitives";

const {
  selectedKey,
  selectedResource,
  selectedItemKey,
  resource,
  model,
  itemDetail,
  loading,
  loadingItem,
  saving,
  validating,
  draftValue,
  referenceValue,
  storedDraftValue,
  effectiveValue,
  canSubmit,
  formattedJson,
  formattedItemJson,
  selectDirectoryItem,
  refreshSelected,
  reloadFromServer,
  validate,
  save,
  updateDraft,
  formatSize,
  formatTime
} = useDataSection();
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <WorkbenchEmptyState v-if="!selectedKey" message="← 选择一个数据资源" />

    <WorkbenchEmptyState v-else-if="loading">
      <template #icon>
        <RefreshCw :size="16" class="spin" :stroke-width="2" />
      </template>
      加载中…
    </WorkbenchEmptyState>

    <template v-else-if="selectedResource?.source === 'editor' && model">
      <WorkbenchAreaHeader class="flex-wrap gap-2.5 px-4" :uppercase="false">
        <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ model.kind }}</span>
        <template v-if="model.kind === 'layered'">
          <span class="text-small text-text-muted">层次：</span>
          <span
            v-for="layer in model.layers"
            :key="layer.key"
            class="rounded-full bg-surface-muted px-2 py-0.5 text-small text-text-muted"
            :class="{ 'bg-accent text-text-on-accent': layer.key === model.writableLayerKey }"
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
      </WorkbenchAreaHeader>

      <div class="scrollbar-thin flex-1 overflow-y-auto px-4 py-3">
        <SchemaNode
          :node="model.uiTree"
          :model-value="draftValue"
          :inherited="referenceValue"
          :stored-value="storedDraftValue"
          :effective-value="effectiveValue"
          :editor-features="model.editorFeatures"
          :depth="0"
          @update:model-value="updateDraft"
        />
      </div>
    </template>

    <template v-else-if="selectedResource?.source === 'browser' && resource">
      <WorkbenchAreaHeader class="gap-2.5 overflow-hidden px-4" :uppercase="false">
        <span class="truncate font-mono text-small text-text-subtle">{{ resource.path }}</span>
        <template #actions>
        <button class="btn-ghost ml-auto" :disabled="loading" @click="refreshSelected">
          <RefreshCw :size="13" :stroke-width="2" :class="{ spin: loading }" />
        </button>
        </template>
      </WorkbenchAreaHeader>

      <div v-if="resource.kind === 'single_json'" class="scrollbar-thin flex-1 overflow-auto px-4 py-3">
        <pre class="m-0 overflow-auto p-0 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap wrap-break-word">{{ formattedJson }}</pre>
      </div>

      <div v-else class="flex min-h-0 flex-1 overflow-hidden">
        <div class="scrollbar-thin w-55 shrink-0 overflow-y-auto border-r border-border-default">
          <WorkbenchListItem
            v-for="item in resource.items"
            :key="item.key"
            :selected="selectedItemKey === item.key"
            multiline
            @select="selectDirectoryItem(item.key)"
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
          </WorkbenchListItem>
          <WorkbenchEmptyState v-if="resource.items.length === 0" :centered="false" class="justify-center px-3 py-6 text-center text-small text-text-subtle" message="目录为空" />
        </div>

        <div class="scrollbar-thin flex flex-1 flex-col overflow-auto">
          <WorkbenchEmptyState v-if="!selectedItemKey" message="← 选择一个文件" />
          <WorkbenchEmptyState v-else-if="loadingItem">
            <template #icon>
              <RefreshCw :size="14" class="spin" :stroke-width="2" />
            </template>
          </WorkbenchEmptyState>
          <template v-else-if="itemDetail">
            <WorkbenchAreaHeader class="gap-3 px-4" :uppercase="false">
              <span class="flex-1 truncate font-mono text-small text-text-muted">{{ itemDetail.path }}</span>
              <span class="shrink-0 text-small text-text-subtle">{{ formatSize(itemDetail.size) }}</span>
              <span class="shrink-0 text-small text-text-subtle">{{ formatTime(itemDetail.updatedAt) }}</span>
            </WorkbenchAreaHeader>
            <pre class="m-0 overflow-auto px-4 py-3 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap wrap-break-word">{{ formattedItemJson }}</pre>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>
