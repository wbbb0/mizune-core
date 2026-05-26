<script setup lang="ts">
import { onMounted } from "vue";
import { Plus, RefreshCw } from "lucide-vue-next";
import SessionListItem from "@/components/sessions/SessionListItem.vue";
import { useSessionsSection } from "@/composables/sections/useSessionsSection";
import { WorkbenchIconButton, WorkbenchSidebarListPane } from "@workbench-kit/vue-workbench";

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
  <WorkbenchSidebarListPane
    title="会话"
    :items="store.list"
    :loading="loading"
    empty-message="暂无活跃会话"
    :item-key="(session) => session.id"
  >
    <template #actions>
      <WorkbenchIconButton :icon="Plus" title="新建 Web 会话" @click="openCreateDialog" />
      <WorkbenchIconButton :icon="RefreshCw" :disabled="loading" title="刷新" @click="refreshSessions" />
    </template>
    <template #item="{ item: session }">
      <SessionListItem
        :session="session"
        :selected="store.selectedId === session.id"
        @select="selectSession(session.id)"
        @open-actions="openSessionActions"
      />
    </template>
  </WorkbenchSidebarListPane>
</template>
