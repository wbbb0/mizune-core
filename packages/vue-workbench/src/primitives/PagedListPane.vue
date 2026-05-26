<script setup lang="ts" generic="TItem">
import { computed, onMounted } from "vue";
import WorkbenchEmptyState from "./WorkbenchEmptyState.vue";

const props = withDefaults(defineProps<{
  title: string;
  items: TItem[];
  total?: number;
  page: number;
  pageSize: number;
  pageSizeOptions?: number[];
  pageSizeStorageKey?: string;
  getKey?: (item: TItem, index: number) => string | number;
  loading?: boolean;
  emptyMessage?: string;
}>(), {
  pageSizeOptions: () => [25, 50, 100, 200],
  loading: false,
  emptyMessage: "暂无数据"
});

const emit = defineEmits<{
  "update:page": [page: number];
  "update:pageSize": [pageSize: number];
}>();

const validPageSizeOptions = computed(() => {
  const options = props.pageSizeOptions
    .filter((option) => Number.isInteger(option) && option > 0);
  return [...new Set(options)];
});
const normalizedPageSize = computed(() =>
  validPageSizeOptions.value.includes(props.pageSize)
    ? props.pageSize
    : (validPageSizeOptions.value[0] ?? Math.max(1, Math.trunc(props.pageSize || 1)))
);
const pageCount = computed(() => Math.max(1, Math.ceil((props.total ?? props.items.length) / normalizedPageSize.value)));
const normalizedPage = computed(() => Math.min(pageCount.value, Math.max(1, props.page)));
const loadedFrom = computed(() => (props.total === 0 || props.items.length === 0) ? 0 : ((normalizedPage.value - 1) * normalizedPageSize.value + 1));
const loadedTo = computed(() => (props.total === 0 || props.items.length === 0) ? 0 : ((normalizedPage.value - 1) * normalizedPageSize.value + props.items.length));
const pageButtons = computed(() => {
  const pages = new Set<number>([1, pageCount.value]);
  for (let page = normalizedPage.value - 2; page <= normalizedPage.value + 2; page += 1) {
    if (page >= 1 && page <= pageCount.value) pages.add(page);
  }
  return [...pages].sort((left, right) => left - right);
});

function safeGetStorageItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetStorageItem(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is optional for this primitive; keep the UI usable if it is blocked.
  }
}

function safeRemoveStorageItem(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Best-effort cleanup only.
  }
}

function readStoredPageSize(): number | null {
  if (!props.pageSizeStorageKey || typeof window === "undefined") return null;
  const raw = safeGetStorageItem(props.pageSizeStorageKey);
  if (!raw) return null;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && validPageSizeOptions.value.includes(parsed)) {
    return parsed;
  }
  safeRemoveStorageItem(props.pageSizeStorageKey);
  return null;
}

function writeStoredPageSize(pageSize: number) {
  if (!props.pageSizeStorageKey || typeof window === "undefined") return;
  safeSetStorageItem(props.pageSizeStorageKey, String(pageSize));
}

function goToPage(page: number) {
  const next = Math.min(pageCount.value, Math.max(1, page));
  if (next !== props.page) emit("update:page", next);
}

function changePageSize(event: Event) {
  const pageSize = Number((event.target as HTMLSelectElement).value);
  if (!validPageSizeOptions.value.includes(pageSize)) return;
  writeStoredPageSize(pageSize);
  emit("update:pageSize", pageSize);
}

function getItemKey(item: TItem, index: number): string | number {
  return props.getKey?.(item, index) ?? index;
}

onMounted(() => {
  const stored = readStoredPageSize();
  if (stored && stored !== props.pageSize) {
    emit("update:pageSize", stored);
    return;
  }
  if (normalizedPageSize.value !== props.pageSize) {
    emit("update:pageSize", normalizedPageSize.value);
  }
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border-default bg-surface-panel px-4 py-2">
      <div class="min-w-0">
        <div class="truncate text-small font-medium text-text-secondary">{{ title }}</div>
        <div class="font-mono text-small text-text-subtle">
          {{ loadedFrom }}-{{ loadedTo }}{{ total !== undefined ? ` / ${total}` : "" }}
        </div>
      </div>
      <div class="flex items-center gap-2">
        <select class="input-base h-7 px-1.5 py-0.5 text-small" :value="normalizedPageSize" :disabled="loading" @change="changePageSize">
          <option v-for="option in validPageSizeOptions" :key="option" :value="option">{{ option }} / 页</option>
        </select>
        <slot name="actions" />
      </div>
    </div>

    <div class="scrollbar-thin min-h-0 flex-1 overflow-auto">
      <slot name="content">
        <slot name="header" />
        <template v-for="(item, index) in items" :key="getItemKey(item, index)">
          <slot name="item" :item="item" :index="index" />
        </template>
        <WorkbenchEmptyState
          v-if="items.length === 0"
          class="justify-center px-3 py-6 text-center text-small text-text-subtle"
          :message="emptyMessage"
        />
      </slot>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border-default bg-surface-panel px-4 py-2">
      <button class="btn btn-secondary" :disabled="loading || normalizedPage <= 1" @click="goToPage(normalizedPage - 1)">上一页</button>
      <div class="flex flex-wrap items-center justify-center gap-1">
        <template v-for="(pageNumber, index) in pageButtons" :key="pageNumber">
          <span v-if="index > 0 && pageNumber - pageButtons[index - 1]! > 1" class="px-1 text-small text-text-subtle">...</span>
          <button
            class="btn btn-secondary min-w-8"
            :class="{ 'border-accent text-accent': pageNumber === normalizedPage }"
            :disabled="loading"
            @click="goToPage(pageNumber)"
          >
            {{ pageNumber }}
          </button>
        </template>
      </div>
      <button class="btn btn-secondary" :disabled="loading || normalizedPage >= pageCount" @click="goToPage(normalizedPage + 1)">下一页</button>
    </div>
  </div>
</template>
