<script setup lang="ts">
import { WorkbenchAreaHeader, WorkbenchEmptyState } from "@workbench-kit/vue";
import { useSkillsSection } from "@/composables/sections/useSkillsSection";
import SkillContentEditor from "./SkillContentEditor.vue";
import SkillHistory from "./SkillHistory.vue";
const state = useSkillsSection();
const { selectedId, record, draft, catalog, loading, busy, error, dirty, conflicted, versions, preview } = state;
function reload() { if (selectedId.value && (!dirty.value || window.confirm("是否放弃当前草稿并重新读取？"))) void state.select(selectedId.value); }
function remove() { if (record.value && window.confirm(`删除技能 ${record.value.name} 及其全部版本？此操作不可撤销。`)) void state.remove(); }
function rollback(revision: number) { if (window.confirm(`回滚到 v${revision}？当前未保存修改将被替换，并创建一个新版本。`)) void state.rollback(revision); }
</script>
<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <WorkbenchEmptyState v-if="!selectedId" message="← 选择一个技能，或新增技能" />
    <template v-else>
      <WorkbenchAreaHeader :title="record?.name || selectedId" :uppercase="false" class="flex-wrap gap-2">
        <span class="text-small text-text-subtle">{{ record ? `v${record.revision}` : '新技能' }}{{ dirty ? ' · 未保存' : '' }}</span>
        <template #actions><div class="flex flex-wrap gap-2">
          <button class="btn btn-secondary" :disabled="busy || loading" @click="reload">重新读取</button>
          <button v-if="record" class="btn btn-secondary text-danger" :disabled="busy || loading" @click="remove">删除</button>
          <button class="btn btn-primary" :disabled="busy || loading || !dirty || conflicted" @click="state.save">{{ busy ? '处理中…' : '保存' }}</button>
        </div></template>
      </WorkbenchAreaHeader>
      <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
        <div v-if="error" role="alert" class="mb-4 rounded border border-danger/30 p-3 text-small text-danger">{{ error }}</div>
        <WorkbenchEmptyState v-if="loading" message="正在读取技能…" />
        <div v-else-if="draft" class="mx-auto grid max-w-5xl gap-5">
          <p class="break-all font-mono text-small text-text-subtle">{{ selectedId }}</p>
          <p v-if="record" class="text-small text-text-muted">最近修改：{{ record.updatedBy }} · {{ new Date(record.updatedAt).toLocaleString() }}<br>{{ catalog?.skills.find(item => item.id === selectedId)?.unavailableReason || '模型可用' }}</p>
          <SkillContentEditor :key="selectedId" :draft="draft" :disabled="busy" :toolsets="catalog?.toolsets ?? []" />
          <button v-if="record" class="btn btn-secondary justify-self-start" :disabled="busy" @click="state.history">读取版本历史</button>
          <SkillHistory v-if="record && versions" :versions="versions" :current-revision="record.revision" :preview="preview" :disabled="busy || conflicted" @inspect="state.inspect" @rollback="rollback" />
        </div>
      </div>
    </template>
  </div>
</template>
