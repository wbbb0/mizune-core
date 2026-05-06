<script setup lang="ts">
withDefaults(defineProps<{
  title?: string;
  sticky?: boolean;
  dense?: boolean;
  uppercase?: boolean;
}>(), {
  title: "",
  sticky: true,
  dense: true,
  uppercase: true
});
</script>

<template>
  <header
    :class="[
      sticky ? 'toolbar-header' : 'border-border-default bg-surface-sidebar',
      'flex shrink-0 items-center border-b',
      dense ? 'h-10 px-3 py-1.5' : 'px-4 py-2'
    ]"
  >
    <slot name="leading" />
    <slot>
      <span
        v-if="title"
        :class="[
          'text-small font-semibold text-text-muted',
          uppercase ? 'tracking-[0.08em] uppercase' : ''
        ]"
      >
        {{ title }}
      </span>
    </slot>
    <div v-if="$slots.actions" class="ml-auto flex items-center gap-1.5">
      <slot name="actions" />
    </div>
  </header>
</template>
