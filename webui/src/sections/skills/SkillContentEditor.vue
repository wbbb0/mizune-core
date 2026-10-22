<script setup lang="ts">
import { computed, ref } from "vue";
import type { SkillDraft } from "@/api/skills";
const props = defineProps<{ draft: SkillDraft; disabled: boolean; toolsets: Array<{ id: string; title: string; description: string }> }>();
const resourcePath = ref("");
const resourceError = ref("");
const unknownToolsets = computed(() => props.draft.toolsetIds.filter((id) => !props.toolsets.some((item) => item.id === id)));
function addResource() {
  const path = resourcePath.value.trim();
  if (!/^references\/[a-zA-Z0-9_./-]+\.md$/.test(path) || /[\\\u0000-\u001f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) { resourceError.value = "请输入 references/ 下的相对文件路径，仅支持 Markdown，例如 references/example.md"; return; }
  if (Object.hasOwn(props.draft.resources, path)) { resourceError.value = "该资源已经存在"; return; }
  props.draft.resources[path] = "";
  resourcePath.value = ""; resourceError.value = "";
}
</script>
<template>
  <fieldset :disabled="disabled" class="grid min-w-0 gap-5">
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="grid gap-1 text-small text-text-secondary">用户策略
        <select v-model="draft.userPolicy" class="input-base"><option value="auto">自动：模型可选择</option><option value="disabled">禁用：禁止模型加载</option></select>
      </label>
      <div class="grid gap-2 text-small text-text-secondary">
        <label class="flex items-center gap-2"><input v-model="draft.modelEditable" type="checkbox">允许模型修改此技能</label>
        <label class="flex items-center gap-2"><input v-model="draft.modelPaused" type="checkbox">暂停模型使用</label>
      </div>
      <label v-if="draft.modelPaused" class="grid gap-1 text-small text-text-secondary sm:col-span-2">暂停原因<input v-model="draft.modelPauseReason" class="input-base" placeholder="说明暂停原因"></label>
    </div>
    <label class="grid min-w-0 gap-2 text-small text-text-secondary">SKILL.md（含 name、description 的 YAML frontmatter）
      <textarea v-model="draft.document" aria-label="SKILL.md" rows="18" class="input-base w-full resize-y font-mono text-small leading-6" spellcheck="false" />
    </label>
    <section class="grid gap-2">
      <h3 class="text-ui font-medium text-text-secondary">绑定工具组</h3>
      <p class="text-small text-text-subtle">绑定工具组用于说明技能依赖；实际使用受当前会话工具边界限制。</p>
      <div class="grid gap-2 sm:grid-cols-2">
        <label v-for="toolset in toolsets" :key="toolset.id" class="flex items-start gap-2 rounded border border-border-subtle p-2 text-small text-text-secondary" :title="toolset.description">
          <input v-model="draft.toolsetIds" :value="toolset.id" type="checkbox" class="mt-1"><span>{{ toolset.title }}<span class="block font-mono text-text-subtle">{{ toolset.id }}</span></span>
        </label>
        <label v-for="id in unknownToolsets" :key="id" class="flex items-center gap-2 text-small text-danger"><input v-model="draft.toolsetIds" :value="id" type="checkbox">{{ id }}（当前不可用，可取消绑定）</label>
      </div>
    </section>
    <section class="grid min-w-0 gap-3">
      <h3 class="text-ui font-medium text-text-secondary">参考资源</h3>
      <div v-for="(_, path) in draft.resources" :key="path" class="grid min-w-0 gap-2 rounded border border-border-subtle p-3">
        <div class="flex items-center justify-between gap-2"><span class="break-all font-mono text-small text-text-secondary">{{ path }}</span><button type="button" class="btn btn-secondary shrink-0" @click="delete draft.resources[path]">移除资源</button></div>
        <textarea v-model="draft.resources[path]" :aria-label="String(path)" rows="7" class="input-base w-full resize-y font-mono text-small leading-6" spellcheck="false" />
      </div>
      <div class="flex gap-2"><input v-model="resourcePath" aria-label="资源路径" class="input-base min-w-0 flex-1 font-mono" placeholder="references/example.md" @keydown.enter.prevent="addResource"><button type="button" class="btn btn-secondary shrink-0" @click="addResource">添加资源</button></div>
      <p v-if="resourceError" role="alert" class="text-small text-danger">{{ resourceError }}</p>
    </section>
    <label class="grid gap-1 text-small text-text-secondary">变更说明<input v-model="draft.changeReason" class="input-base" placeholder="说明本次修改的目的"></label>
  </fieldset>
</template>
