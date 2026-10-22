<script setup lang="ts">
import type { SkillRecord, SkillSummary } from "@/api/skills";
defineProps<{ versions: SkillSummary[]; currentRevision: number; preview: SkillRecord | null; disabled: boolean }>();
defineEmits<{ inspect: [revision: number]; rollback: [revision: number] }>();
</script>
<template>
  <section class="grid min-w-0 gap-3 border-t border-border-subtle pt-4">
    <h3 class="text-ui font-medium text-text-secondary">版本历史</h3>
    <div v-for="version in versions" :key="version.revision" class="flex flex-wrap items-center gap-2 rounded border border-border-subtle p-2 text-small">
      <span class="min-w-0 flex-1 text-text-secondary">v{{ version.revision }} · {{ version.updatedBy }} · {{ new Date(version.updatedAt).toLocaleString() }}<span class="block break-words text-text-subtle">{{ version.changeReason }}</span></span>
      <button class="btn btn-secondary" :disabled="disabled" @click="$emit('inspect', version.revision)">查看</button>
      <button class="btn btn-secondary" :disabled="disabled || version.revision === currentRevision" @click="$emit('rollback', version.revision)">回滚到此版</button>
    </div>
    <div v-if="preview" class="grid min-w-0 gap-2 rounded border border-border-subtle p-3">
      <h4 class="text-small text-text-secondary">v{{ preview.revision }} · {{ preview.name }}</h4>
      <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-small text-text-muted">{{ preview.document }}</pre>
      <details v-for="(content, path) in preview.resources" :key="path" class="min-w-0"><summary class="break-all text-small text-text-secondary">{{ path }}</summary><pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-small text-text-muted">{{ content }}</pre></details>
    </div>
  </section>
</template>
