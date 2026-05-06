<script setup lang="ts">
withDefaults(defineProps<{
  message?: string;
  centered?: boolean;
}>(), {
  message: "",
  centered: true
});
</script>

<template>
  <div
    :class="[
      'panel-empty flex gap-2',
      centered ? 'flex-1 items-center justify-center' : 'items-center'
    ]"
  >
    <slot name="icon" />
    <slot>{{ message }}</slot>
    <slot name="actions" />
  </div>
</template>
