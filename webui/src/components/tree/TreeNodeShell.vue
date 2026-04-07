<script setup lang="ts">
import { ChevronRight, ChevronDown } from "lucide-vue-next";

defineProps<{
  collapsible?: boolean;
  expanded?: boolean;
  selected?: boolean;
  childInset?: boolean;
  meta?: string | number;
}>();

defineEmits<{
  toggle: [];
  select: [];
}>();
</script>

<template>
  <div class="min-w-0">
    <div
      class="tree-shell-header flex min-w-0 items-center justify-between gap-2 rounded-md px-1 py-0.75"
      :class="{ 'tree-shell-selected': selected }"
    >
      <button
        v-if="collapsible"
        class="min-w-0 flex flex-1 cursor-pointer items-center bg-transparent text-left hover:text-text-secondary"
        @click="$emit('toggle')"
      >
        <div class="tree-head min-w-0">
          <component :is="expanded ? ChevronDown : ChevronRight" :size="13" :stroke-width="2" class="tree-chevron" />
          <div class="min-w-0 flex-1">
            <slot name="label" />
          </div>
        </div>
      </button>
      <button
        v-else
        class="min-w-0 flex flex-1 cursor-pointer items-center bg-transparent text-left hover:text-text-secondary"
        @click="$emit('select')"
      >
        <div class="tree-head min-w-0">
          <slot name="icon" />
          <div class="min-w-0 flex-1">
            <slot name="label" />
          </div>
        </div>
      </button>

      <div v-if="$slots.actions || $slots.meta || meta !== undefined" class="flex shrink-0 items-center gap-1">
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
