<script setup lang="ts">
import { onMounted } from "vue";
import { Plus, RefreshCw } from "lucide-vue-next";
import SessionListItem from "@/components/sessions/SessionListItem.vue";
import { useSessionsSection } from "@/composables/sections/useSessionsSection";

const {
  store,
  loading,
  initializeSection,
  selectSession,
  refreshSessions,
  openCreateDialog,
  openSessionActions
} = useSessionsSection();

onMounted(() => {
  void initializeSection();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="panel-header flex h-10 shrink-0 items-center justify-between border-b px-3">
      <span class="text-small font-semibold tracking-[0.08em] text-text-muted uppercase">会话</span>
      <div class="flex items-center gap-1">
        <button class="btn-ghost" title="新建 Web 会话" @click="openCreateDialog">
          <Plus :size="14" :stroke-width="2" />
        </button>
        <button class="btn-ghost" :disabled="loading" title="刷新" @click="refreshSessions">
          <RefreshCw :size="14" :class="{ spin: loading }" :stroke-width="2" />
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="store.list.length === 0 && !loading" class="px-3 py-6 text-center text-small text-text-subtle">
        暂无活跃会话
      </div>
      <SessionListItem
        v-for="session in store.list"
        :key="session.id"
        :session="session"
        :selected="store.selectedId === session.id"
        @select="selectSession(session.id)"
        @open-actions="openSessionActions"
      />
    </div>
  </div>
</template>
