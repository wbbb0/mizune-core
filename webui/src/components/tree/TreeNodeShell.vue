<script setup lang="ts">
import { computed } from "vue";
import { ChevronRight, ChevronDown, Folder, FolderOpen } from "lucide-vue-next";

const props = withDefaults(defineProps<{
  collapsible?: boolean;
  expanded?: boolean;
  selected?: boolean;
  childInset?: boolean;
  meta?: string | number;
  iconMode?: "data" | "files";
  indentPx?: number;
}>(), {
  iconMode: "data",
  indentPx: 0
});

defineEmits<{
  toggle: [];
  select: [];
}>();

const collapsibleIcon = computed(() => {
  if (props.iconMode === "files") {
    return props.expanded ? FolderOpen : Folder;
  }
  return props.expanded ? ChevronDown : ChevronRight;
});
</script>

<template>
  <div class="w-max min-w-full">
    <div
      class="tree-shell-header relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1 py-0.75"
      :class="['w-max min-w-full', { 'tree-shell-selected': selected }]"
    >
      <button
        v-if="collapsible"
        class="min-w-0 flex flex-1 cursor-pointer items-center bg-transparent text-left hover:text-text-secondary"
        :style="props.indentPx > 0 ? { paddingLeft: `${props.indentPx}px` } : undefined"
        @click="$emit('toggle')"
      >
        <div class="tree-head min-w-0">
          <component :is="collapsibleIcon" :size="13" :stroke-width="2" class="tree-chevron shrink-0 text-text-muted" />
          <div class="min-w-0 flex-1">
            <slot name="label" />
          </div>
        </div>
      </button>
      <button
        v-else
        class="min-w-0 flex flex-1 cursor-pointer items-center bg-transparent text-left hover:text-text-secondary"
        :style="props.indentPx > 0 ? { paddingLeft: `${props.indentPx}px` } : undefined"
        @click="$emit('select')"
      >
        <div class="tree-head min-w-0">
          <slot name="icon" />
          <div class="min-w-0 flex-1">
            <slot name="label" />
          </div>
        </div>
      </button>

      <div
        v-if="$slots.actions || $slots.meta || meta !== undefined"
        class="flex shrink-0 items-center gap-1 pl-2 sticky right-0 z-1 bg-inherit"
      >
        <slot name="meta">
          <span v-if="meta !== undefined" class="tree-meta">{{ meta }}</span>
        </slot>
        <slot name="actions" />
      </div>
    </div>

    <div v-if="(!collapsible || expanded) && $slots.default" :class="childInset === false ? '' : 'ml-1.5 border-l border-border-default pl-4'">
      <slot />
    </div>
  </div>
</template>
