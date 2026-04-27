<script setup lang="ts">
withDefaults(defineProps<{
  expanded: boolean;
  collapsedLabel: string;
  expandedLabel: string;
  summary?: string | null;
  bodyClass?: string;
}>(), {
  summary: null,
  bodyClass: ""
});

defineEmits<{
  toggle: [];
}>();
</script>

<template>
  <div
    :class="expanded
      ? 'overflow-hidden rounded-lg border border-border-default bg-surface-input'
      : 'flex flex-col'"
  >
    <button
      :class="[
        'flex w-full cursor-pointer items-center justify-between gap-3 px-2.5 py-1.75 text-left text-small text-text-muted hover:text-text-primary',
        expanded ? 'border-0 border-b border-border-default bg-transparent' : 'rounded-lg border border-border-default bg-surface-input'
      ]"
      @click="$emit('toggle')"
    >
      <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{ expanded ? expandedLabel : collapsedLabel }}</span>
      <span v-if="summary" class="min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap text-right">{{ summary }}</span>
    </button>
    <div
      v-if="expanded"
      :class="[
        'scrollbar-thin flex max-h-[min(32rem,60dvh)] flex-col gap-2 overflow-auto p-2.5',
        bodyClass
      ]"
    >
      <slot />
    </div>
  </div>
</template>
