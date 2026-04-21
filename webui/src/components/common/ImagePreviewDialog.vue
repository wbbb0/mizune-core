<script setup lang="ts">
defineProps<{
  src: string;
  alt?: string;
  title?: string;
}>();
</script>

<template>
  <div class="flex min-h-0 flex-1 items-center justify-center bg-surface-app p-3 sm:p-4">
    <img :src="src" :alt="alt || title || '预览图'" class="max-h-full max-w-full rounded object-contain" />
  </div>
</template>
