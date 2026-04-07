<script setup lang="ts">
import { computed } from "vue";
import { Folder, FileText, Image as ImageIcon, File } from "lucide-vue-next";
import TreeNodeShell from "@/components/tree/TreeNodeShell.vue";
import type { WorkspaceItem } from "@/api/workspace";

defineOptions({ name: "WorkspaceFileTree" });

const props = defineProps<{
  items: WorkspaceItem[];
  expandedPaths: string[];
  itemsByPath: Record<string, WorkspaceItem[]>;
  selectedPath: string | null;
}>();

const emit = defineEmits<{
  toggleDirectory: [path: string];
  selectItem: [item: WorkspaceItem];
}>();

const expandedSet = computed(() => new Set(props.expandedPaths));

function itemIcon(item: WorkspaceItem) {
  if (item.kind === "directory") {
    return Folder;
  }
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
  <div class="flex min-w-0 flex-col gap-0.5">
    <template v-for="item in items" :key="item.path">
      <TreeNodeShell
        :collapsible="item.kind === 'directory'"
        :expanded="expandedSet.has(item.path)"
        :selected="selectedPath === item.path"
        :child-inset="false"
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
          <div class="flex min-w-0 items-center gap-1">
            <Folder
              v-if="item.kind === 'directory'"
              :size="13"
              :stroke-width="1.8"
              class="shrink-0 text-text-muted"
            />
            <span class="tree-label">{{ item.name }}</span>
          </div>
        </template>
        <template #meta>
          <span class="tree-meta">{{ item.kind === "directory" ? "目录" : "文件" }}</span>
        </template>

        <template v-if="item.kind === 'directory' && expandedSet.has(item.path)">
          <div class="ml-1.5 border-l border-border-default pl-4">
            <WorkspaceFileTree
              :items="itemsByPath[item.path] ?? []"
              :expanded-paths="expandedPaths"
              :items-by-path="itemsByPath"
              :selected-path="selectedPath"
              @toggle-directory="emit('toggleDirectory', $event)"
              @select-item="emit('selectItem', $event)"
            />
          </div>
        </template>
      </TreeNodeShell>
    </template>
  </div>
</template>
