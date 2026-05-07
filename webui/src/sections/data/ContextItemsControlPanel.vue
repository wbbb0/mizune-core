<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { DatabaseZap, Download, Filter, Layers, RefreshCw, Trash2, Upload } from "lucide-vue-next";
import type { ContextItemFilters, ContextStatus } from "@/api/context";

const props = defineProps<{
  currentFilters: ContextItemFilters;
  contextTotal: number;
  contextStatus: ContextStatus | null;
  loading: boolean;
  maintenanceBusy: boolean;
  applyFilters: (filters: ContextItemFilters) => Promise<void>;
  refreshContextItems: () => Promise<void>;
  exportContextItems: () => Promise<void>;
  importContextItems: () => Promise<void>;
  compactContextUser: () => Promise<void>;
  sweepDeletedContextItems: () => Promise<void>;
  clearContextEmbeddings: () => Promise<void>;
  resetContextIndex: () => Promise<void>;
  rebuildContextIndex: () => Promise<void>;
  bulkDeleteContextItems: () => Promise<void>;
}>();

const applying = ref(false);
const filters = reactive({
  userId: "",
  scope: "" as ContextItemFilters["scope"],
  sourceType: "" as ContextItemFilters["sourceType"],
  status: "" as ContextItemFilters["status"]
});

const total = computed(() => props.contextTotal);
const status = computed(() => props.contextStatus);
const loading = computed(() => props.loading);
const maintenanceBusy = computed(() => props.maintenanceBusy);
const controlsBusy = computed(() => maintenanceBusy.value || applying.value);
const actionBusy = computed(() => loading.value || controlsBusy.value);

function syncFiltersFromState() {
  const current = props.currentFilters;
  filters.userId = current.userId ?? "";
  filters.scope = current.scope ?? "";
  filters.sourceType = current.sourceType ?? "";
  filters.status = current.status ?? "";
}

function buildFilters(): ContextItemFilters {
  return {
    ...props.currentFilters,
    userId: filters.userId.trim(),
    scope: filters.scope,
    sourceType: filters.sourceType,
    status: filters.status,
    offset: 0
  };
}

async function applyCurrentFilters() {
  if (controlsBusy.value) return;
  applying.value = true;
  try {
    await props.applyFilters(buildFilters());
  } finally {
    applying.value = false;
  }
}

async function runAction(action: () => Promise<void>) {
  if (actionBusy.value) return;
  await action();
}

watch(() => props.currentFilters, syncFiltersFromState, { deep: true });
syncFiltersFromState();
</script>

<template>
  <div class="flex flex-col gap-4">
    <section class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 text-small font-medium text-text-primary">
          <Filter :size="14" :stroke-width="2" />
          筛选
        </div>
        <span class="text-small text-text-subtle">{{ total }} 条</span>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1.5 text-small text-text-muted">
          用户 ID
          <input
            v-model="filters.userId"
            :disabled="controlsBusy"
            placeholder="留空表示全部用户"
            autocomplete="off"
            class="input-base font-mono text-ui"
          />
        </label>
        <label class="flex flex-col gap-1.5 text-small text-text-muted">
          范围
          <select v-model="filters.scope" :disabled="controlsBusy" class="input-base text-ui">
            <option value="">全部</option>
            <option value="session">session</option>
            <option value="user">user</option>
            <option value="global">global</option>
            <option value="toolset">toolset</option>
            <option value="mode">mode</option>
          </select>
        </label>
        <label class="flex flex-col gap-1.5 text-small text-text-muted">
          类型
          <select v-model="filters.sourceType" :disabled="controlsBusy" class="input-base text-ui">
            <option value="">全部</option>
            <option value="chunk">chunk</option>
            <option value="summary">summary</option>
            <option value="fact">fact</option>
            <option value="rule">rule</option>
          </select>
        </label>
        <label class="flex flex-col gap-1.5 text-small text-text-muted">
          状态
          <select v-model="filters.status" :disabled="controlsBusy" class="input-base text-ui">
            <option value="">全部</option>
            <option value="active">active</option>
            <option value="archived">archived</option>
            <option value="deleted">deleted</option>
            <option value="superseded">superseded</option>
          </select>
        </label>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn btn-primary" :disabled="controlsBusy" @click="applyCurrentFilters">
          <RefreshCw v-if="applying" :size="13" class="spin" :stroke-width="2" />
          应用筛选
        </button>
        <span v-if="status" class="text-small text-text-subtle">
          raw {{ status.stats.rawMessages }} · vec {{ status.stats.embeddings }}
        </span>
      </div>
    </section>

    <section class="flex flex-col gap-2 border-t border-border-subtle pt-3">
      <div class="text-small font-medium text-text-primary">列表</div>
      <div class="grid gap-2 sm:grid-cols-3">
        <button type="button" class="btn btn-secondary justify-start" :disabled="actionBusy" @click="runAction(refreshContextItems)">
          <RefreshCw :size="13" :stroke-width="2" :class="{ spin: loading }" />
          刷新
        </button>
        <button type="button" class="btn btn-secondary justify-start" :disabled="actionBusy" @click="runAction(exportContextItems)">
          <Download :size="13" :stroke-width="2" />
          导出
        </button>
        <button type="button" class="btn btn-secondary justify-start" :disabled="actionBusy" @click="runAction(importContextItems)">
          <Upload :size="13" :stroke-width="2" />
          导入
        </button>
      </div>
    </section>

    <section class="flex flex-col gap-2 border-t border-border-subtle pt-3">
      <div class="text-small font-medium text-text-primary">维护</div>
      <div class="grid gap-2 sm:grid-cols-2">
        <button type="button" class="btn btn-secondary justify-start" :disabled="actionBusy" @click="runAction(compactContextUser)">
          <Layers :size="13" :stroke-width="2" />
          压缩当前用户
        </button>
        <button type="button" class="btn btn-secondary justify-start" :disabled="actionBusy" @click="runAction(sweepDeletedContextItems)">
          <Trash2 :size="13" :stroke-width="2" />
          清理已删除项
        </button>
        <button type="button" class="btn btn-secondary justify-start" :disabled="actionBusy" @click="runAction(clearContextEmbeddings)">
          <DatabaseZap :size="13" :stroke-width="2" />
          清空 embedding
        </button>
        <button type="button" class="btn btn-secondary justify-start" :disabled="actionBusy" @click="runAction(resetContextIndex)">
          <RefreshCw :size="13" :stroke-width="2" :class="{ spin: maintenanceBusy }" />
          重置索引
        </button>
        <button type="button" class="btn btn-secondary justify-start sm:col-span-2" :disabled="actionBusy" @click="runAction(rebuildContextIndex)">
          <DatabaseZap :size="13" :stroke-width="2" />
          补齐 embedding 并重建索引
        </button>
      </div>
    </section>

    <section class="flex flex-col gap-2 border-t border-border-subtle pt-3">
      <div class="text-small font-medium text-danger">危险操作</div>
      <button type="button" class="btn btn-danger justify-start" :disabled="actionBusy" @click="runAction(bulkDeleteContextItems)">
        <Trash2 :size="13" :stroke-width="2" />
        按当前筛选批量删除
      </button>
    </section>
  </div>
</template>
