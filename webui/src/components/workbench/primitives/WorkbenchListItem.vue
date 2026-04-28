<script setup lang="ts">
withDefaults(defineProps<{
  selected?: boolean;
  title?: string;
  subtitle?: string | null;
  meta?: string | number | null;
  dense?: boolean;
  multiline?: boolean;
}>(), {
  selected: false,
  title: "",
  subtitle: null,
  meta: null,
  dense: true,
  multiline: false
});

defineEmits<{
  select: [];
}>();
</script>

<template>
  <button
    class="list-row flex w-full items-center gap-3 text-left"
    :class="[
      selected ? 'is-selected' : '',
      dense ? 'px-3 py-1.75' : 'px-3 py-2',
      multiline ? 'justify-start' : 'justify-between'
    ]"
    type="button"
    @click="$emit('select')"
  >
    <slot name="leading" />
    <div class="min-w-0 flex-1">
      <slot>
        <div class="truncate text-ui text-text-secondary">{{ title }}</div>
        <div v-if="subtitle" class="truncate text-small text-text-subtle">{{ subtitle }}</div>
      </slot>
    </div>
    <slot name="trailing">
      <span v-if="meta !== null && meta !== undefined" class="rounded-full bg-surface-muted px-1.5 text-small text-text-subtle">{{ meta }}</span>
    </slot>
  </button>
</template>
