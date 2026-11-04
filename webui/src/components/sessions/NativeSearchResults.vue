<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ metadata?: Record<string, unknown> }>();
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const results = computed(() => {
  const nativeResults = [...(Array.isArray(props.metadata?.citations) ? props.metadata.citations : []),
    ...(Array.isArray(props.metadata?.searchSources) ? props.metadata.searchSources : [])]
    .map(record).flatMap(item => {
      if (typeof item.url !== "string") return [];
      try {
        const url = new URL(item.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return [];
        return [{ title: typeof item.title === "string" ? item.title : url.hostname, url: url.href }];
      } catch { return []; }
    });
  const blocks = props.metadata?.anthropicContentBlocks;
  if (!Array.isArray(blocks)) return uniqueResults(nativeResults);
  const anthropicResults = blocks.flatMap((value) => {
    const block = record(value);
    if (block.type !== "web_search_tool_result") return [];
    const content = Array.isArray(block.content) ? block.content : [block.content];
    return content.map(record).flatMap((item) => {
      if (item.type === "web_search_tool_result_error") return [{ title: `搜索未完成：${String(item.error_code ?? "未知错误")}`, url: "" }];
      if (item.type !== "web_search_result" || typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) return [];
      return [{ title: typeof item.title === "string" ? item.title : item.url, url: item.url }];
    });
  });
  return uniqueResults([...nativeResults, ...anthropicResults]);
});
function uniqueResults(rows: Array<{ title: string; url: string }>) {
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = row.url || row.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
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
