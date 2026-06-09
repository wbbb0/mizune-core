<script setup lang="ts">
import { computed, onMounted, ref, unref, type MaybeRef } from "vue";
import { RefreshCw, RotateCcw, Save, Trash2 } from "lucide-vue-next";
import { sessionsApi } from "@/api/sessions";
import type { SessionSnapshotSummary } from "@/api/types";
import { ApiError } from "@/api/client";
import { useWorkbenchToasts, useWorkbenchWindows } from "@workbench-kit/vue";

const props = defineProps<{
  sessionId: string;
  windowId?: string;
  sessionGenerating?: MaybeRef<boolean>;
  onRestored?: () => void | Promise<void>;
}>();

const snapshots = ref<SessionSnapshotSummary[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const snapshotLabel = ref("");
const creating = ref(false);
const busyId = ref<string | null>(null);
const isSessionGenerating = computed(() => unref(props.sessionGenerating) === true);
const toast = useWorkbenchToasts();
const windows = useWorkbenchWindows();
let requestSeq = 0;

onMounted(() => {
  void loadSnapshots();
});

async function loadSnapshots() {
  const currentSeq = ++requestSeq;
  loading.value = true;
  errorMessage.value = "";
  try {
    const loaded = await sessionsApi.listSnapshots(props.sessionId);
    if (currentSeq === requestSeq) {
      snapshots.value = loaded.snapshots;
    }
  } catch (error: unknown) {
    if (currentSeq === requestSeq) {
      errorMessage.value = toErrorMessage(error, "载入存档失败");
    }
  } finally {
    if (currentSeq === requestSeq) {
      loading.value = false;
    }
  }
}

async function createSnapshot() {
  creating.value = true;
  try {
    const label = snapshotLabel.value.trim();
    const result = await sessionsApi.createSnapshot(props.sessionId, label ? { label } : {});
    snapshots.value = [
      result.snapshot,
      ...snapshots.value.filter((snapshot) => snapshot.id !== result.snapshot.id)
    ];
    snapshotLabel.value = "";
    toast.push({ type: "success", message: "已存档" });
  } catch (error: unknown) {
    toast.push({ type: "error", message: toErrorMessage(error, "存档失败") });
  } finally {
    creating.value = false;
  }
}

async function restoreSnapshot(snapshot: SessionSnapshotSummary) {
  const confirmed = await confirmSnapshotAction({
    title: "确认读档",
    description: "读档后将立即覆盖当前会话内容。",
    content: `将读取存档「${snapshot.label}」。当前会话内容会被该存档覆盖。`,
    actionLabel: "确认读档",
    variant: "primary"
  });
  if (!confirmed) {
    return;
  }
  busyId.value = `restore:${snapshot.id}`;
  try {
    await sessionsApi.restoreSnapshot(props.sessionId, snapshot.id);
    await Promise.all([
      props.onRestored?.(),
      loadSnapshots()
    ]);
    toast.push({ type: "success", message: "已读档" });
  } catch (error: unknown) {
    toast.push({ type: "error", message: toErrorMessage(error, "读档失败") });
  } finally {
    busyId.value = null;
  }
}

async function deleteSnapshot(snapshot: SessionSnapshotSummary) {
  const confirmed = await confirmSnapshotAction({
    title: "确认删除存档",
    description: "删除后该存档无法恢复。",
    content: `将删除存档「${snapshot.label}」。此操作不可恢复。`,
    actionLabel: "确认删除",
    variant: "danger"
  });
  if (!confirmed) {
    return;
  }
  busyId.value = `delete:${snapshot.id}`;
  try {
    await sessionsApi.deleteSnapshot(props.sessionId, snapshot.id);
    snapshots.value = snapshots.value.filter((item) => item.id !== snapshot.id);
    toast.push({ type: "success", message: "已删除存档" });
  } catch (error: unknown) {
    toast.push({ type: "error", message: toErrorMessage(error, "删除存档失败") });
  } finally {
    busyId.value = null;
  }
}

function isBusy(snapshot: SessionSnapshotSummary, action: "restore" | "delete") {
  return busyId.value === `${action}:${snapshot.id}`;
}

async function confirmSnapshotAction(input: {
  title: string;
  description: string;
  content: string;
  actionLabel: string;
  variant: "primary" | "danger";
}): Promise<boolean> {
  const result = await windows.openDialog({
    ...(props.windowId ? { kind: "child-dialog" as const, parentId: props.windowId } : {}),
    title: input.title,
    description: input.description,
    size: "sm",
    modal: true,
    blocks: [
      {
        kind: "text" as const,
        content: input.content
      }
    ],
    actions: [
      {
        id: "confirm",
        label: input.actionLabel,
        variant: input.variant
      }
    ]
  });
  return result.reason === "action" && result.actionId === "confirm";
}

function formatSnapshotTime(timestampMs: number) {
  return new Date(timestampMs).toLocaleString();
}

function toErrorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : fallback;
}
</script>

<template>
  <div class="flex min-h-0 flex-col gap-3">
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <input
        v-model="snapshotLabel"
        class="input-base h-8 min-w-48 flex-1 text-small"
        placeholder="存档名称（可选）"
        :disabled="creating || isSessionGenerating"
        @keydown.enter.prevent="createSnapshot"
      >
      <button
        class="btn btn-primary h-8 shrink-0 gap-1.5 px-2 text-small"
        type="button"
        :disabled="creating || isSessionGenerating"
        title="保存当前会话快照"
        @click="createSnapshot"
      >
        <Save :size="13" :stroke-width="2" />
        存档
      </button>
      <button
        class="btn-ghost flex h-8 shrink-0 items-center gap-1 px-2 text-small text-text-muted hover:text-text-primary"
        type="button"
        :disabled="loading"
        title="刷新存档列表"
        @click="loadSnapshots"
      >
        <RefreshCw :size="12" :stroke-width="2" :class="{ spin: loading }" />
        刷新
      </button>
    </div>

    <div v-if="isSessionGenerating" class="text-small text-text-subtle">
      当前会话正在回复，完成后可存档或读档。
    </div>
    <div v-else-if="errorMessage" class="text-small text-danger">
      {{ errorMessage }}
    </div>
    <div v-else-if="loading" class="text-small text-text-subtle">
      正在载入存档…
    </div>
    <div v-else-if="snapshots.length === 0" class="rounded border border-dashed border-border-default px-3 py-6 text-center text-small text-text-subtle">
      暂无存档
    </div>
    <div v-else class="scrollbar-thin max-h-[52vh] divide-y divide-border-subtle overflow-y-auto rounded border border-border-default bg-surface-panel">
      <div
        v-for="snapshot in snapshots"
        :key="snapshot.id"
        class="flex min-w-0 flex-wrap items-center gap-2 px-2 py-1.5"
      >
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-1.5">
            <span class="truncate text-small font-medium text-text-primary">{{ snapshot.label }}</span>
            <span
              v-if="snapshot.hasScenarioHostState"
              class="shrink-0 rounded border border-border-subtle px-1 text-[11px] leading-4 text-text-subtle"
            >
              Scenario
            </span>
          </div>
          <div class="truncate text-[11px] leading-4 text-text-subtle">
            {{ formatSnapshotTime(snapshot.createdAtMs) }} · {{ snapshot.transcriptCount }} 条记录 · {{ snapshot.modeId }}
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <button
            class="btn-ghost flex h-7 items-center gap-1 px-2 text-small text-text-muted hover:text-text-primary"
            type="button"
            :disabled="isSessionGenerating || busyId !== null"
            title="读取这个存档"
            @click="restoreSnapshot(snapshot)"
          >
            <RefreshCw v-if="isBusy(snapshot, 'restore')" :size="12" :stroke-width="2" class="spin" />
            <RotateCcw v-else :size="12" :stroke-width="2" />
            读档
          </button>
          <button
            class="btn-ghost flex h-7 items-center gap-1 px-2 text-small text-text-muted hover:text-danger"
            type="button"
            :disabled="busyId !== null"
            title="删除这个存档"
            @click="deleteSnapshot(snapshot)"
          >
            <RefreshCw v-if="isBusy(snapshot, 'delete')" :size="12" :stroke-width="2" class="spin" />
            <Trash2 v-else :size="12" :stroke-width="2" />
            删除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
