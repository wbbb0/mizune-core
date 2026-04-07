<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { RefreshCw } from "lucide-vue-next";
import AppLayout from "@/components/layout/AppLayout.vue";
import SessionListItem from "@/components/sessions/SessionListItem.vue";
import ChatPanel from "@/components/sessions/ChatPanel.vue";
import { useSessionsStore } from "@/stores/sessions";

const store   = useSessionsStore();
const loading = ref(false);
const layout  = ref<InstanceType<typeof AppLayout> | null>(null);

// Poll session list every 5s for status updates (pending count, generating)
let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  loading.value = true;
  try {
    await store.refresh();
  } finally {
    loading.value = false;
  }
  pollTimer = setInterval(() => store.refresh(), 5_000);
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
</script>

<template>
  <AppLayout ref="layout">
    <!-- ── Session list (side panel) ── -->
    <template #side>
      <div class="panel-header flex h-10 shrink-0 items-center justify-between border-b px-3">
        <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">会话</span>
        <button class="btn-ghost" :disabled="loading" title="刷新" @click="onRefresh">
          <RefreshCw :size="14" :class="{ spin: loading }" :stroke-width="2" />
        </button>
      </div>

      <div v-if="store.list.length === 0 && !loading" class="px-3 py-6 text-center text-small text-text-subtle">
        暂无活跃会话
      </div>

      <div class="overflow-y-auto">
        <SessionListItem
          v-for="s in store.list"
          :key="s.id"
          :session="s"
          :selected="store.selectedId === s.id"
          @select="onSelectSession(s.id)"
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
        {{ store.active.id.split(":").slice(1).join(":") }}
      </span>
    </template>
  </AppLayout>
</template>
