<script setup lang="ts">
import { onMounted, ref } from "vue";
import { BookOpen, Plus, RefreshCw } from "lucide-vue-next";
import { WorkbenchAreaHeader, WorkbenchIconButton, WorkbenchListItem, WorkbenchEmptyState, useWorkbenchNavigation } from "@workbench-kit/vue";
import { useSkillsSection } from "@/composables/sections/useSkillsSection";
const state = useSkillsSection();
const { catalog, selectedId, loading, busy, dirty, error } = state;
const newId = ref("");
const creating = ref(false);
const navigation = useWorkbenchNavigation();
function canLeave() { return !dirty.value || window.confirm("当前技能有未保存修改，是否放弃？"); }
function select(id: string) { if (id === selectedId.value || !canLeave()) return; void state.select(id); navigation.showArea("mainArea"); }
function create() { if (!newId.value.trim() || !canLeave()) return; if (!state.create(newId.value)) return; newId.value = ""; creating.value = false; navigation.showArea("mainArea"); }
onMounted(() => { void state.refresh(); });
</script>
<template>
  <div class="flex h-full min-h-0 flex-col bg-surface">
    <WorkbenchAreaHeader title="实例技能">
      <template #actions>
        <WorkbenchIconButton :icon="Plus" title="新增技能" :disabled="busy" @click="creating = !creating" />
        <WorkbenchIconButton :icon="RefreshCw" title="刷新目录" :disabled="loading || busy" @click="state.refresh" />
      </template>
    </WorkbenchAreaHeader>
    <div class="border-b border-border-subtle p-3 text-small text-text-subtle">
      <p>{{ catalog?.config.enabled ? '技能已启用' : '技能总开关已关闭' }} · {{ catalog?.skills.length ?? 0 }} 项</p>
      <p class="mt-1">{{ catalog?.config.modelMaintenanceEnabled ? '允许模型维护' : '模型维护关闭' }} · {{ catalog?.config.plannerSelectionEnabled ? 'Planner 可选技能' : 'Planner 选择关闭' }}</p>
      <RouterLink to="/config" class="mt-2 inline-block text-accent">管理全局开关与预算 →</RouterLink>
    </div>
    <form v-if="creating" class="flex gap-2 border-b border-border-subtle p-3" @submit.prevent="create">
      <input v-model="newId" aria-label="新技能 ID" class="input-base min-w-0 flex-1 font-mono" placeholder="skill-id" :disabled="busy">
      <button class="btn btn-primary" :disabled="busy || !newId.trim()">新增</button>
    </form>
    <div v-if="error" role="alert" class="m-3 rounded border border-danger/30 p-2 text-small text-danger">{{ error }}</div>
    <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
      <WorkbenchListItem v-for="skill in catalog?.skills ?? []" :key="skill.id" :selected="selectedId === skill.id" :title="skill.name" :disabled="busy" :meta="`${skill.id} · v${skill.revision} · ${skill.effectiveAvailable ? '模型可用' : skill.unavailableReason || '不可用'}`" @select="select(skill.id)">
        <template #icon><BookOpen :size="15" /></template>
      </WorkbenchListItem>
      <WorkbenchEmptyState v-if="catalog && !catalog.skills.length" message="暂无技能，点击 + 新增" />
    </div>
  </div>
</template>
