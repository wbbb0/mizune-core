<script setup lang="ts">
import WorkbenchDialog from "@/components/common/WorkbenchDialog.vue";

defineProps<{
  open: boolean;
  src: string;
  alt?: string;
  title?: string;
}>();

defineEmits<{
  close: [];
}>();
</script>

<template>
  <WorkbenchDialog
    :open="open"
    :title="title || alt || '图片预览'"
    variant="fullscreen"
    panel-class="max-w-none"
    body-class="flex min-h-0 flex-1 items-center justify-center bg-surface-app p-3 sm:p-4"
    @close="$emit('close')"
  >
    <img :src="src" :alt="alt || title || '预览图'" class="max-h-full max-w-full rounded object-contain" />
  </WorkbenchDialog>
</template>
