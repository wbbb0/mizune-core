<script setup lang="ts">
import { RefreshCw, ChevronRight, ChevronDown, Save } from "lucide-vue-next";
import SchemaNode from "@/components/editor/SchemaNode.vue";
import { useDataSection } from "@/composables/sections/useDataSection";
import type { DirectoryItem } from "@/api/data";

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
      </header>

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
      <header class="toolbar-header flex h-10 shrink-0 items-center gap-2.5 overflow-hidden border-b px-4">
        <span class="truncate font-mono text-small text-text-subtle">{{ resource.path }}</span>
        <button class="btn-ghost ml-auto" :disabled="loading" @click="refreshSelected">
          <RefreshCw :size="13" :stroke-width="2" :class="{ spin: loading }" />
        </button>
      </header>

      <div v-if="resource.kind === 'single_json'" class="scrollbar-thin flex-1 overflow-auto px-4 py-3">
        <pre class="m-0 overflow-auto p-0 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap wrap-break-word">{{ formattedJson }}</pre>
      </div>

      <div v-else class="flex min-h-0 flex-1 overflow-hidden">
        <div class="scrollbar-thin w-55 shrink-0 overflow-y-auto border-r border-border-default">
          <button
            v-for="item in resource.items"
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
            <pre class="m-0 overflow-auto px-4 py-3 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap wrap-break-word">{{ formattedItemJson }}</pre>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>
