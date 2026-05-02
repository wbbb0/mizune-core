<script setup lang="ts">
import { RefreshCw, ChevronRight, ChevronDown, Save, Trash2, Pin, Pencil, Layers, DatabaseZap, Download, Upload } from "lucide-vue-next";
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
  contextItems,
  contextTotal,
  contextFilters,
  contextStatus,
  deletingContextItemId,
  pinningContextItemId,
  contextMaintenanceBusy,
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
  refreshContextItems,
  deleteContextItem,
  editContextItem,
  toggleContextItemPinned,
  bulkDeleteContextItems,
  exportContextItems,
  importContextItems,
  compactContextUser,
  sweepDeletedContextItems,
  clearContextEmbeddings,
  resetContextIndex,
  rebuildContextIndex,
  selectDirectoryItem,
  refreshSelected,
  reloadFromServer,
  validate,
  save,
  updateDraft,
  formatSize,
  formatTime,
  formatContextMeta
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

    <template v-else-if="selectedResource?.source === 'context'">
      <WorkbenchAreaHeader class="flex-wrap gap-2 px-4" :uppercase="false">
        <input
          v-model="contextFilters.userId"
          class="input-base max-w-38"
          placeholder="用户 ID"
          autocomplete="off"
        />
        <select v-model="contextFilters.scope" class="input-base max-w-30">
          <option value="">范围</option>
          <option value="session">session</option>
          <option value="user">user</option>
          <option value="global">global</option>
          <option value="toolset">toolset</option>
          <option value="mode">mode</option>
        </select>
        <select v-model="contextFilters.sourceType" class="input-base max-w-30">
          <option value="">类型</option>
          <option value="chunk">chunk</option>
          <option value="summary">summary</option>
          <option value="fact">fact</option>
          <option value="rule">rule</option>
        </select>
        <select v-model="contextFilters.status" class="input-base max-w-30">
          <option value="">状态</option>
          <option value="active">active</option>
          <option value="archived">archived</option>
          <option value="deleted">deleted</option>
          <option value="superseded">superseded</option>
        </select>
        <span class="text-small text-text-subtle">{{ contextTotal }} 条</span>
        <span v-if="contextStatus" class="text-small text-text-subtle">
          raw {{ contextStatus.stats.rawMessages }} · vec {{ contextStatus.stats.embeddings }}
        </span>
        <span
          v-if="contextStatus"
          class="rounded bg-surface-muted px-1.5 py-0.5 text-small"
          :class="contextStatus.store.available ? 'text-success' : 'text-danger'"
          :title="contextStatus.store.disabledReason || contextStatus.store.dbPath"
        >
          store {{ contextStatus.store.available ? "ok" : "down" }}
        </span>
        <span
          v-if="contextStatus"
          class="rounded bg-surface-muted px-1.5 py-0.5 text-small"
          :class="contextStatus.embedding.configured ? 'text-success' : 'text-warning'"
          :title="contextStatus.embedding.modelRefs.join(', ') || '未配置 embedding 模型'"
        >
          embedding {{ contextStatus.embedding.configured ? "ok" : "missing" }}
        </span>
        <template #actions>
          <button class="btn-ghost ml-auto" :disabled="loading || contextMaintenanceBusy" title="压缩当前用户旧片段" @click="compactContextUser">
            <Layers :size="13" :stroke-width="2" />
          </button>
          <button class="btn-ghost" :disabled="loading || contextMaintenanceBusy" title="清理已删除项" @click="sweepDeletedContextItems">
            <Trash2 :size="13" :stroke-width="2" />
          </button>
          <button class="btn-ghost" :disabled="loading || contextMaintenanceBusy" title="清空当前过滤范围 embedding" @click="clearContextEmbeddings">
            <DatabaseZap :size="13" :stroke-width="2" />
          </button>
          <button class="btn-ghost" :disabled="loading || contextMaintenanceBusy" title="重置索引" @click="resetContextIndex">
            <RefreshCw :size="13" :stroke-width="2" :class="{ spin: contextMaintenanceBusy }" />
          </button>
          <button class="btn-ghost" :disabled="loading || contextMaintenanceBusy" title="补齐 embedding 并重建索引" @click="rebuildContextIndex">
            <DatabaseZap :size="13" :stroke-width="2" />
          </button>
          <button class="btn-ghost" :disabled="loading || contextMaintenanceBusy" title="按当前过滤批量删除" @click="bulkDeleteContextItems">
            <Trash2 :size="13" :stroke-width="2" class="text-danger" />
          </button>
          <button class="btn-ghost" :disabled="loading || contextMaintenanceBusy" title="导出当前过滤范围" @click="exportContextItems">
            <Download :size="13" :stroke-width="2" />
          </button>
          <button class="btn-ghost" :disabled="loading || contextMaintenanceBusy" title="导入 JSONL" @click="importContextItems">
            <Upload :size="13" :stroke-width="2" />
          </button>
          <button class="btn-ghost" :disabled="loading" title="刷新" @click="refreshContextItems">
            <RefreshCw :size="13" :stroke-width="2" :class="{ spin: loading }" />
          </button>
        </template>
      </WorkbenchAreaHeader>

      <div class="scrollbar-thin flex-1 overflow-y-auto">
        <div
          v-for="item in contextItems"
          :key="item.itemId"
          class="border-b border-border-subtle px-4 py-3"
        >
          <div class="flex min-w-0 items-start gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <span class="truncate text-small font-medium text-text-primary">{{ item.title || item.itemId }}</span>
                <span class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small text-text-subtle">{{ item.sensitivity }}</span>
              </div>
              <div class="mt-1 truncate font-mono text-small text-text-subtle">{{ formatContextMeta(item) }}</div>
            </div>
            <button
              class="btn-ghost shrink-0"
              :title="item.pinned ? '取消固定' : '固定'"
              :disabled="pinningContextItemId === item.itemId"
              @click="toggleContextItemPinned(item)"
            >
              <RefreshCw v-if="pinningContextItemId === item.itemId" :size="13" class="spin" :stroke-width="2" />
              <Pin v-else :size="13" :stroke-width="2" :class="{ 'text-accent': item.pinned }" />
            </button>
            <button
              class="btn-ghost shrink-0"
              title="编辑"
              @click="editContextItem(item)"
            >
              <Pencil :size="13" :stroke-width="2" />
            </button>
            <button
              class="btn-ghost shrink-0"
              title="删除"
              :disabled="deletingContextItemId === item.itemId"
              @click="deleteContextItem(item.itemId)"
            >
              <RefreshCw v-if="deletingContextItemId === item.itemId" :size="13" class="spin" :stroke-width="2" />
              <Trash2 v-else :size="13" :stroke-width="2" />
            </button>
          </div>
          <p class="my-2 whitespace-pre-wrap wrap-break-word text-ui leading-6 text-text-secondary">{{ item.text }}</p>
          <div class="flex flex-wrap gap-2 font-mono text-small text-text-subtle">
            <span>{{ item.itemId }}</span>
            <span>{{ formatTime(item.updatedAt) }}</span>
            <span v-if="item.lastRetrievedAt">retrieved {{ formatTime(item.lastRetrievedAt) }}</span>
          </div>
        </div>
        <WorkbenchEmptyState v-if="contextItems.length === 0" class="justify-center px-3 py-6 text-center text-small text-text-subtle" message="暂无上下文记忆" />
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
