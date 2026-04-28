<script setup lang="ts">
import { onMounted } from "vue";
import { Plus, RefreshCw } from "lucide-vue-next";
import SessionListItem from "@/components/sessions/SessionListItem.vue";
import { useSessionsSection } from "@/composables/sections/useSessionsSection";
import { WorkbenchAreaHeader, WorkbenchEmptyState } from "@/components/workbench/primitives";

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
    <WorkbenchAreaHeader title="会话">
      <template #actions>
        <button class="btn-ghost" title="新建 Web 会话" @click="openCreateDialog">
          <Plus :size="14" :stroke-width="2" />
        </button>
        <button class="btn-ghost" :disabled="loading" title="刷新" @click="refreshSessions">
          <RefreshCw :size="14" :class="{ spin: loading }" :stroke-width="2" />
        </button>
      </template>
    </WorkbenchAreaHeader>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <WorkbenchEmptyState v-if="store.list.length === 0 && !loading" :centered="false" class="justify-center px-3 py-6 text-center text-small text-text-subtle" message="暂无活跃会话" />
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
