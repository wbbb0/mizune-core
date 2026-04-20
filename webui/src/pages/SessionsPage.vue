<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { Plus, RefreshCw } from "lucide-vue-next";
import AppLayout from "@/components/layout/AppLayout.vue";
import WorkbenchDialog from "@/components/common/WorkbenchDialog.vue";
import SessionListItem from "@/components/sessions/SessionListItem.vue";
import ChatPanel from "@/components/sessions/ChatPanel.vue";
import CreateSessionDialog from "@/components/sessions/CreateSessionDialog.vue";
import { useSessionsStore } from "@/stores/sessions";

const store   = useSessionsStore();
const loading = ref(false);
const layout  = ref<InstanceType<typeof AppLayout> | null>(null);
const createDialogOpen = ref(false);
const createDialogBusy = ref(false);
const createDialogError = ref("");
const actionsDialogSessionId = ref<string | null>(null);
const actionsDialogBusy = ref(false);

// Fallback polling: only refresh list while stream is unavailable.
let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  loading.value = true;
  try {
    await store.refresh();
  } finally {
    loading.value = false;
  }
  pollTimer = setInterval(() => {
    if (!store.active || store.active.streamStatus !== "connected") {
      void store.refresh();
    }
  }, 10_000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  store.deselectSession();
});

function onSelectSession(id: string) {
  store.selectSession(id);
  layout.value?.openDetail();
}

async function onRefresh() {
  loading.value = true;
  try { await store.refresh(); } finally { loading.value = false; }
}

function onCreateSession() {
  createDialogError.value = "";
  createDialogOpen.value = true;
}

function closeCreateDialog() {
  if (createDialogBusy.value) {
    return;
  }
  createDialogOpen.value = false;
  createDialogError.value = "";
}

async function onCreateSessionSubmit(payload: {
  title?: string;
  modeId?: string;
}) {
  createDialogBusy.value = true;
  createDialogError.value = "";
  try {
    await store.createSession(payload);
    createDialogOpen.value = false;
    createDialogError.value = "";
  } catch (error: unknown) {
    createDialogError.value = error instanceof Error ? error.message : "创建会话失败";
  } finally {
    createDialogBusy.value = false;
  }
  layout.value?.openDetail();
}

async function onDeleteSession(sessionId: string) {
  actionsDialogBusy.value = true;
  try {
    await store.deleteSession(sessionId);
    actionsDialogSessionId.value = null;
  } finally {
    actionsDialogBusy.value = false;
  }
}

async function onSwitchSessionMode(sessionId: string, modeId: string) {
  actionsDialogBusy.value = true;
  try {
    await store.switchSessionMode(sessionId, modeId);
    actionsDialogSessionId.value = null;
  } finally {
    actionsDialogBusy.value = false;
  }
}

function onOpenSessionActions(sessionId: string) {
  actionsDialogSessionId.value = sessionId;
}

function currentActionsSession() {
  return store.list.find((item) => item.id === actionsDialogSessionId.value) ?? null;
}

function modeSupportsCurrentSession(modeId: string): boolean {
  const session = currentActionsSession();
  const mode = store.modes.find((item) => item.id === modeId);
  if (!session || !mode?.allowedChatTypes || mode.allowedChatTypes.length === 0) {
    return true;
  }
  return mode.allowedChatTypes.includes(session.type);
}

function closeActionsDialog() {
  if (actionsDialogBusy.value) {
    return;
  }
  actionsDialogSessionId.value = null;
}
</script>

<template>
  <AppLayout ref="layout">
    <!-- ── Session list (side panel) ── -->
    <template #side>
      <div class="panel-header flex h-10 shrink-0 items-center justify-between border-b px-3">
        <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">会话</span>
        <div class="flex items-center gap-1">
          <button class="btn-ghost" title="新建 Web 会话" @click="onCreateSession">
            <Plus :size="14" :stroke-width="2" />
          </button>
          <button class="btn-ghost" :disabled="loading" title="刷新" @click="onRefresh">
            <RefreshCw :size="14" :class="{ spin: loading }" :stroke-width="2" />
          </button>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <div v-if="store.list.length === 0 && !loading" class="px-3 py-6 text-center text-small text-text-subtle">
          暂无活跃会话
        </div>
        <SessionListItem
          v-for="s in store.list"
          :key="s.id"
          :session="s"
          :selected="store.selectedId === s.id"
          @select="onSelectSession(s.id)"
          @open-actions="onOpenSessionActions"
        />
      </div>
    </template>

    <!-- ── Chat panel (main panel) ── -->
    <template #main>
      <ChatPanel />
    </template>

    <!-- Mobile header slot: show current session label -->
    <template #mobile-header>
      <span v-if="store.active" class="font-mono text-ui font-medium text-text-secondary">
        {{ store.active.participantLabel || store.active.participantUserId || store.active.id }}
      </span>
    </template>
  </AppLayout>

  <CreateSessionDialog
    :open="createDialogOpen"
    :busy="createDialogBusy"
    :error-message="createDialogError"
    :modes="store.modes"
    @close="closeCreateDialog"
    @submit="onCreateSessionSubmit"
  />

  <WorkbenchDialog
    :open="Boolean(actionsDialogSessionId)"
    title="会话操作"
    description="切换当前会话模式，或删除该会话。"
    variant="content"
    width-class="max-w-lg"
    body-class="px-4 py-4"
    @close="closeActionsDialog"
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <div class="text-small font-medium text-text-secondary">切换模式</div>
        <div class="flex flex-col gap-2">
          <button
            v-for="mode in store.modes"
            :key="mode.id"
            class="flex items-start justify-between rounded-lg border border-border-default bg-surface-sidebar px-3 py-2 text-left hover:bg-surface-active disabled:opacity-60"
            :disabled="actionsDialogBusy || !actionsDialogSessionId || !modeSupportsCurrentSession(mode.id)"
            @click="actionsDialogSessionId && onSwitchSessionMode(actionsDialogSessionId, mode.id)"
          >
            <div class="min-w-0 flex-1">
              <div class="text-ui font-medium text-text-secondary">{{ mode.title }}</div>
              <div class="mt-1 text-small text-text-muted">{{ mode.description }}</div>
              <div v-if="!modeSupportsCurrentSession(mode.id)" class="mt-1 text-small text-text-subtle">
                当前会话类型不支持此模式
              </div>
            </div>
            <span
              v-if="store.list.find((item) => item.id === actionsDialogSessionId)?.modeId === mode.id"
              class="ml-3 shrink-0 text-small text-text-subtle"
            >
              当前
            </span>
          </button>
        </div>
      </div>

      <div class="border-t border-border-subtle pt-4">
        <button
          class="flex w-full items-center justify-center rounded-lg border border-[color:color-mix(in_srgb,var(--danger)_45%,transparent)] bg-surface-danger px-3 py-2 text-ui font-medium text-danger disabled:opacity-60"
          :disabled="actionsDialogBusy || !actionsDialogSessionId"
          @click="actionsDialogSessionId && onDeleteSession(actionsDialogSessionId)"
        >
          删除会话
        </button>
      </div>
    </div>

    <template #footer>
      <button class="btn btn-secondary" :disabled="actionsDialogBusy" @click="closeActionsDialog">
        关闭
      </button>
    </template>
  </WorkbenchDialog>
</template>
