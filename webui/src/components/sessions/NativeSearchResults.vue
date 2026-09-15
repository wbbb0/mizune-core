<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ metadata?: Record<string, unknown> }>();
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const results = computed(() => {
  const blocks = props.metadata?.anthropicContentBlocks;
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((value) => {
    const block = record(value);
    if (block.type !== "web_search_tool_result") return [];
    const content = Array.isArray(block.content) ? block.content : [block.content];
    return content.map(record).flatMap((item) => {
      if (item.type === "web_search_tool_result_error") return [{ title: `搜索未完成：${String(item.error_code ?? "未知错误")}`, url: "" }];
      if (item.type !== "web_search_result" || typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) return [];
      return [{ title: typeof item.title === "string" ? item.title : item.url, url: item.url }];
    });
  });
});
</script>

<template>
  <details v-if="results.length" class="rounded border border-border-default p-2 text-small text-text-muted">
    <summary class="cursor-pointer">联网搜索来源与状态</summary>
    <ul class="mt-2 space-y-1">
      <li v-for="(result, index) in results" :key="index">
        <a v-if="result.url" :href="result.url" target="_blank" rel="noopener noreferrer" class="break-all underline">{{ result.title }}</a>
        <span v-else>{{ result.title }}</span>
      </li>
    </ul>
  </details>
</template>
