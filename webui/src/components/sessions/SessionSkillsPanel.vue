<script setup lang="ts">
import { ref } from "vue";
import { WorkbenchDisclosure, WorkbenchEmptyState } from "@workbench-kit/vue";
import type { SessionSkillsView } from "../../../../src/types/skills";
defineProps<{ skills: SessionSkillsView | null }>();
const expanded = ref(false);
</script>
<template>
  <WorkbenchDisclosure :expanded="expanded" collapsed-title="本任务技能" expanded-title="本任务技能" :summary="skills ? `${skills.loaded.length} 已加载 · ${skills.rejected.length} 未加载` : '暂无记录'" @toggle="expanded = !expanded">
    <WorkbenchEmptyState v-if="!skills" :centered="false" message="暂无技能加载记录" />
    <div v-else class="grid min-w-0 gap-3 text-small">
      <p class="break-all font-mono text-text-subtle">任务：{{ skills.taskId || '无当前任务' }}</p>
      <p v-if="!skills.loaded.length && !skills.rejected.length" class="text-text-subtle">当前任务尚未加载技能。</p>
      <div v-for="skill in skills.loaded" :key="`${skill.id}:${skill.revision}`" class="rounded border border-border-subtle p-3">
        <div class="flex flex-wrap items-center justify-between gap-2 text-text-secondary"><span>{{ skill.name }} · v{{ skill.revision }}</span><span>已加载 · {{ skill.bodyTokens }} tokens</span></div>
        <p class="mt-1 break-all font-mono text-text-subtle">{{ skill.id }}</p>
        <p class="mt-1 whitespace-pre-wrap break-words text-text-muted">加载原因：{{ skill.reason }}</p>
      </div>
      <div v-for="(skill, index) in skills.rejected" :key="`${skill.id}:${index}`" class="rounded border border-danger/30 p-3 text-text-muted"><span class="font-mono">{{ skill.id }}</span> · 未加载<p class="mt-1 whitespace-pre-wrap break-words">{{ skill.reason }}</p></div>
      <p class="text-text-subtle">显示实际加载的版本；技能更新后，本任务已加载内容保持不变。</p>
    </div>
  </WorkbenchDisclosure>
</template>
