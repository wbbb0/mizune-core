<script setup lang="ts">
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
  <teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6"
      @click.self="$emit('close')"
    >
      <div class="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border-default bg-surface-panel shadow-2xl">
        <div class="flex items-center gap-3 border-b border-border-default px-4 py-2">
          <span class="min-w-0 flex-1 truncate text-ui font-medium text-text-secondary">{{ title || alt || "图片预览" }}</span>
          <button class="btn-ghost" @click="$emit('close')">关闭</button>
        </div>
        <div class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-app p-4">
          <img :src="src" :alt="alt || title || '预览图'" class="max-h-full max-w-full rounded object-contain" />
        </div>
      </div>
    </div>
  </teleport>
</template>
