<script setup lang="ts">
import { computed } from "vue";
import { RefreshCw, ChevronRight, ChevronDown, Save, Trash2, Pin, Pencil, SlidersHorizontal } from "lucide-vue-next";
import { SchemaNode } from "@workbench-kit/vue-resource-editor";
import { useDataSection } from "@/composables/sections/useDataSection";
import type { DirectoryItem } from "@/api/data";
import { WorkbenchAreaHeader, WorkbenchEmptyState, WorkbenchListItem } from "@workbench-kit/vue-workbench";

const {
  selectedKey,
  selectedResource,
  selectedItemKey,
  resource,
  model,
  itemDetail,
  resourceRows,
  resourceDirectoryItems,
  registryDraftValue,
  registryStoredValue,
  registryRowDraftValue,
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
  registryCanSubmit,
  formattedJson,
  formattedItemJson,
  formattedRowsJson,
  refreshContextItems,
  openContextFiltersDialog,
  deleteContextItem,
  createRegistryRow,
  saveRegistryRow,
  deleteRegistryRow,
  editContextItem,
  toggleContextItemPinned,
  selectDirectoryItem,
  refreshSelected,
  reloadFromServer,
  validate,
  save,
  saveRegistrySingleton,
  updateDraft,
  updateRegistryDraft,
  updateRegistryRowDraft,
  updateRegistryExistingRowDraft,
  getRegistryExistingRowDraft,
  canSaveRegistryRow,
  formatSize,
  formatTime,
  formatContextMeta
} = useDataSection();

type SessionDataRow = {
  sessionId: string;
  type: "private" | "group";
  source: "onebot" | "web" | null;
  modeId: string | null;
  participantKind: "user" | "group";
  participantId: string;
  title: string | null;
  titleSource: "default" | "auto" | "manual" | null;
  replyDelivery: "onebot" | "web" | null;
  transcriptCount: number;
  lastActiveAtMs: number;
  lastMessageAtMs: number | null;
  updatedAtMs: number;
};

type SessionTranscriptDataRow = {
  sessionId: string;
  itemIndex: number;
  itemId: string;
  groupId: string;
  kind: string;
  role: string | null;
  llmVisible: 0 | 1;
  runtimeExcluded: 0 | 1;
  timestampMs: number;
  itemHash: string;
  item: unknown;
};

const sessionRows = computed(() => resourceRows.value?.rows as SessionDataRow[] | undefined);
const transcriptRows = computed(() => resourceRows.value?.rows as SessionTranscriptDataRow[] | undefined);

function rowText(value: unknown): string {
  return value == null || value === "" ? "—" : String(value);
}

function summarizeTranscriptItem(row: SessionTranscriptDataRow): string {
  const item = row.item as Record<string, unknown> | null;
  if (!item) return "";
  const text = typeof item.text === "string"
    ? item.text
    : typeof item.content === "string"
      ? item.content
      : typeof item.summary === "string"
        ? item.summary
        : "";
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}
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
          :default-value="model.schemaDefaultValue"
          :stored-value="storedDraftValue"
          :effective-value="effectiveValue"
          :editor-features="model.editorFeatures"
          :depth="0"
          @update:model-value="updateDraft"
        />
      </div>
    </template>

    <template v-else-if="selectedResource?.source === 'context'">
      <WorkbenchAreaHeader class="gap-2 overflow-hidden px-4" :uppercase="false">
        <div class="scrollbar-thin flex min-w-0 flex-1 items-center gap-2 overflow-x-auto whitespace-nowrap py-1">
          <button class="btn btn-secondary shrink-0" :disabled="loading" title="管理上下文记忆" @click="openContextFiltersDialog">
            <SlidersHorizontal :size="13" :stroke-width="2" />
            管理
          </button>
          <span class="shrink-0 text-small text-text-subtle">{{ contextTotal }} 条</span>
          <span v-if="contextFilters.userId" class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 font-mono text-small text-text-subtle">user {{ contextFilters.userId }}</span>
          <span v-if="contextFilters.scope" class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small text-text-subtle">{{ contextFilters.scope }}</span>
          <span v-if="contextFilters.sourceType" class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small text-text-subtle">{{ contextFilters.sourceType }}</span>
          <span v-if="contextFilters.status" class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small text-text-subtle">{{ contextFilters.status }}</span>
          <span v-if="contextStatus" class="shrink-0 text-small text-text-subtle">
            raw {{ contextStatus.stats.rawMessages }} · vec {{ contextStatus.stats.embeddings }}
          </span>
          <span
            v-if="contextStatus"
            class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small"
            :class="contextStatus.store.available ? 'text-success' : 'text-danger'"
            :title="[
              contextStatus.store.disabledReason || contextStatus.store.dbPath,
              ...(contextStatus.store.tableGroups ?? []).map((group) => `${group.groupId} v${group.actualSchemaVersion ?? '?'} / ${group.schemaVersion}${group.lastResetReason ? ` · ${group.lastResetReason}` : ''}`)
            ].join('\n')"
          >
            store {{ contextStatus.store.available ? "ok" : "down" }}
          </span>
          <span v-if="contextStatus?.store.tableGroups?.length" class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small text-text-subtle">
            schema {{ contextStatus.store.tableGroups.length }}
          </span>
          <span
            v-if="contextStatus"
            class="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-small"
            :class="contextStatus.embedding.configured ? 'text-success' : 'text-warning'"
            :title="contextStatus.embedding.modelRefs.join(', ') || '未配置 embedding 模型'"
          >
            embedding {{ contextStatus.embedding.configured ? "ok" : "missing" }}
          </span>
        </div>
        <template #actions>
          <div class="scrollbar-thin flex max-w-full items-center gap-1 overflow-x-auto whitespace-nowrap py-1">
            <button class="btn-ghost shrink-0" :disabled="loading || contextMaintenanceBusy" title="刷新" @click="refreshContextItems">
              <RefreshCw :size="13" :stroke-width="2" :class="{ spin: loading }" />
            </button>
          </div>
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
            <div class="scrollbar-thin flex max-w-[45%] shrink-0 gap-1 overflow-x-auto whitespace-nowrap pb-1">
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

    <template v-else-if="selectedResource?.source === 'registry' && resource">
      <WorkbenchAreaHeader class="gap-2.5 overflow-hidden px-4" :uppercase="false">
        <span class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ resource.shape }}</span>
        <span class="truncate font-mono text-small text-text-subtle">{{ resource.storage.path || resource.storage.tables?.join(", ") || resource.storage.tableGroup || resource.storage.database }}</span>
        <template #actions>
        <button class="btn-ghost ml-auto" :disabled="loading" @click="refreshSelected">
          <RefreshCw :size="13" :stroke-width="2" :class="{ spin: loading }" />
        </button>
        <button
          v-if="resource.shape === 'singleton' && resource.editable"
          class="btn btn-primary"
          :disabled="!registryCanSubmit"
          @click="saveRegistrySingleton"
        >
          <Save :size="13" :stroke-width="1.5" />
          {{ saving ? "保存中…" : "保存" }}
        </button>
        </template>
      </WorkbenchAreaHeader>

      <div v-if="resource.shape === 'singleton' && resource.editable && resource.uiTree" class="scrollbar-thin flex-1 overflow-y-auto px-4 py-3">
        <SchemaNode
          :node="resource.uiTree"
          :model-value="registryDraftValue"
          :stored-value="registryStoredValue"
          :effective-value="registryDraftValue"
          :depth="0"
          @update:model-value="updateRegistryDraft"
        />
      </div>

      <div v-else-if="resource.shape === 'file' || resource.shape === 'singleton'" class="scrollbar-thin flex-1 overflow-auto px-4 py-3">
        <pre class="m-0 overflow-auto p-0 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap wrap-break-word">{{ formattedJson }}</pre>
      </div>

      <div v-else-if="resource.shape === 'collection' || resource.shape === 'log'" class="scrollbar-thin flex-1 overflow-auto px-4 py-3">
        <div v-if="resource.shape === 'collection' && resource.editable && resource.rowOperations?.create && resource.rowUiTree" class="mb-4 border-b border-border-subtle pb-4">
          <SchemaNode
            :node="resource.rowUiTree"
            :model-value="registryRowDraftValue"
            :stored-value="{}"
            :effective-value="registryRowDraftValue"
            :depth="0"
            @update:model-value="updateRegistryRowDraft"
          />
          <div class="mt-3 flex justify-end">
            <button class="btn btn-primary" :disabled="saving" @click="createRegistryRow">
              <Save :size="13" :stroke-width="1.5" />
              新增
            </button>
          </div>
        </div>
        <div class="mb-2 flex items-center gap-2 text-small text-text-subtle">
          <span>{{ resourceRows?.total ?? resourceRows?.rows.length ?? 0 }} 行</span>
          <span v-if="resourceRows">offset {{ resourceRows.offset }} · limit {{ resourceRows.limit }}</span>
        </div>
        <div v-if="resource.shape === 'collection' && resource.editable && resource.rowOperations?.patch && resource.rowUiTree && resourceRows?.rows.length" class="space-y-3">
          <div
            v-for="(row, index) in resourceRows.rows"
            :key="`${index}`"
            class="border-b border-border-subtle pb-3"
          >
            <div class="mb-2 flex justify-end gap-1.5">
              <button class="btn-ghost" :disabled="!canSaveRegistryRow(row)" title="保存" @click="saveRegistryRow(row)">
                <Save :size="13" :stroke-width="1.5" />
              </button>
              <button v-if="resource.rowOperations?.delete" class="btn-ghost" :disabled="saving" title="删除" @click="deleteRegistryRow(row)">
                <Trash2 :size="13" :stroke-width="2" />
              </button>
            </div>
            <SchemaNode
              :node="resource.rowUiTree"
              :model-value="getRegistryExistingRowDraft(row)"
              :stored-value="row"
              :effective-value="getRegistryExistingRowDraft(row)"
              :depth="0"
              @update:model-value="updateRegistryExistingRowDraft(row, $event)"
            />
          </div>
        </div>
        <div v-else-if="resource.key === 'sessions'" class="overflow-hidden rounded border border-border-default">
          <div class="grid grid-cols-[minmax(16rem,1.5fr)_6rem_8rem_8rem_5rem_8rem_8rem] border-b border-border-default bg-surface-muted px-3 py-2 font-mono text-small text-text-subtle">
            <span>session</span>
            <span>type</span>
            <span>source</span>
            <span>mode</span>
            <span>items</span>
            <span>active</span>
            <span>updated</span>
          </div>
          <div
            v-for="row in sessionRows"
            :key="row.sessionId"
            class="grid grid-cols-[minmax(16rem,1.5fr)_6rem_8rem_8rem_5rem_8rem_8rem] border-b border-border-subtle px-3 py-2 text-small last:border-b-0"
          >
            <div class="min-w-0">
              <div class="truncate font-medium text-text-secondary" :title="row.title || row.sessionId">{{ row.title || row.sessionId }}</div>
              <div class="truncate font-mono text-text-subtle" :title="row.sessionId">{{ row.sessionId }}</div>
              <div class="truncate font-mono text-text-subtle">{{ row.participantKind }} {{ row.participantId }}</div>
            </div>
            <span class="font-mono text-text-muted">{{ row.type }}</span>
            <span class="font-mono text-text-muted">{{ rowText(row.source) }}</span>
            <span class="truncate font-mono text-text-muted" :title="row.modeId ?? undefined">{{ rowText(row.modeId) }}</span>
            <span class="font-mono text-text-muted">{{ row.transcriptCount }}</span>
            <span class="font-mono text-text-muted">{{ formatTime(row.lastActiveAtMs) }}</span>
            <span class="font-mono text-text-muted">{{ formatTime(row.updatedAtMs) }}</span>
          </div>
        </div>
        <div v-else-if="resource.key === 'session_transcript_items'" class="overflow-hidden rounded border border-border-default">
          <div class="grid grid-cols-[8rem_minmax(14rem,1.2fr)_6rem_8rem_minmax(18rem,2fr)] border-b border-border-default bg-surface-muted px-3 py-2 font-mono text-small text-text-subtle">
            <span>time</span>
            <span>session</span>
            <span>index</span>
            <span>kind</span>
            <span>content</span>
          </div>
          <details
            v-for="row in transcriptRows"
            :key="`${row.sessionId}:${row.itemId}`"
            class="border-b border-border-subtle last:border-b-0"
          >
            <summary class="grid cursor-pointer grid-cols-[8rem_minmax(14rem,1.2fr)_6rem_8rem_minmax(18rem,2fr)] px-3 py-2 text-small hover:bg-surface-hover">
              <span class="font-mono text-text-muted">{{ formatTime(row.timestampMs) }}</span>
              <span class="min-w-0 truncate font-mono text-text-subtle" :title="row.sessionId">{{ row.sessionId }}</span>
              <span class="font-mono text-text-muted">#{{ row.itemIndex }}</span>
              <span class="truncate font-mono text-text-muted" :title="row.kind">{{ row.kind }}</span>
              <span class="min-w-0 truncate text-text-secondary" :title="summarizeTranscriptItem(row)">{{ summarizeTranscriptItem(row) || row.itemId }}</span>
            </summary>
            <div class="border-t border-border-subtle bg-surface-input px-3 py-2">
              <div class="mb-2 flex flex-wrap gap-2 font-mono text-small text-text-subtle">
                <span>{{ row.itemId }}</span>
                <span>{{ row.groupId }}</span>
                <span>{{ row.role ?? "no-role" }}</span>
                <span>{{ row.llmVisible ? "llm" : "hidden" }}</span>
                <span v-if="row.runtimeExcluded">excluded</span>
                <span>{{ row.itemHash.slice(0, 12) }}</span>
              </div>
              <pre class="m-0 overflow-auto p-0 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap wrap-break-word">{{ JSON.stringify(row.item, null, 2) }}</pre>
            </div>
          </details>
        </div>
        <pre v-else class="m-0 overflow-auto p-0 font-mono text-mono leading-6 text-text-primary whitespace-pre-wrap wrap-break-word">{{ formattedRowsJson }}</pre>
      </div>

      <div v-else class="flex min-h-0 flex-1 overflow-hidden">
        <div class="scrollbar-thin w-55 shrink-0 overflow-y-auto border-r border-border-default">
          <WorkbenchListItem
            v-for="item in resourceDirectoryItems"
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
          <WorkbenchEmptyState v-if="resourceDirectoryItems.length === 0" :centered="false" class="justify-center px-3 py-6 text-center text-small text-text-subtle" message="目录为空" />
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
