<script setup lang="ts">
import { computed } from "vue";
import { FileText, Image as ImageIcon, File } from "lucide-vue-next";
import { TreeNodeShell } from "@workbench-kit/vue-workbench";
import type { LocalFileItem } from "./types";

defineOptions({ name: "WorkspaceFileTree" });

const props = withDefaults(defineProps<{
  /** 当前层要渲染的文件/目录列表。 */
  items: LocalFileItem[];
  /** 已展开目录 path 列表。 */
  expandedPaths: string[];
  /** 目录 path 到其子项列表的缓存。 */
  itemsByPath: Record<string, LocalFileItem[]>;
  /** 当前选中的文件或目录 path。 */
  selectedPath: string | null;
  /** 当前递归深度。根层默认为 0。 */
  depth?: number;
}>(), {
  depth: 0
});

const emit = defineEmits<{
  toggleDirectory: [path: string];
  selectItem: [item: LocalFileItem];
}>();

const expandedSet = computed(() => new Set(props.expandedPaths));

function itemIcon(item: LocalFileItem) {
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(item.name)) {
    return ImageIcon;
  }
  if (/\.(txt|md|json|ya?ml|log|ts|tsx|js|jsx|vue|css|html)$/i.test(item.name)) {
    return FileText;
  }
  return File;
}
</script>

<template>
  <div class="flex w-max min-w-full flex-col gap-0.5">
    <template v-for="item in items" :key="item.path">
      <TreeNodeShell
        :collapsible="item.kind === 'directory'"
        :expanded="expandedSet.has(item.path)"
        :selected="selectedPath === item.path"
        :child-inset="false"
        :indent-px="props.depth * 22"
        icon-mode="files"
        @toggle="emit('toggleDirectory', item.path)"
        @select="emit('selectItem', item)"
      >
        <template #icon>
          <component
            v-if="item.kind !== 'directory'"
            :is="itemIcon(item)"
            :size="13"
            :stroke-width="1.8"
            class="shrink-0 text-text-muted"
          />
        </template>
        <template #label>
          <span class="tree-label">{{ item.name }}</span>
        </template>
        <template #meta>
          <span class="tree-meta">{{ item.kind === "directory" ? "目录" : "文件" }}</span>
        </template>

        <template v-if="item.kind === 'directory' && expandedSet.has(item.path)">
          <div>
            <WorkspaceFileTree
              :items="itemsByPath[item.path] ?? []"
              :expanded-paths="expandedPaths"
              :items-by-path="itemsByPath"
              :selected-path="selectedPath"
              :depth="props.depth + 1"
              @toggle-directory="emit('toggleDirectory', $event)"
              @select-item="emit('selectItem', $event)"
            />
          </div>
        </template>
      </TreeNodeShell>
    </template>
  </div>
</template>
