<script setup lang="ts">
import { computed } from "vue";
import { Ellipsis } from "lucide-vue-next";
import type { SessionListItem } from "@/api/types";

const props = defineProps<{
  session: SessionListItem;
  selected: boolean;
}>();

const emit = defineEmits<{
  select: [];
  openActions: [sessionId: string];
}>();

const display = computed(() => {
  return {
    badge: props.session.type === "group" ? "G" : props.session.source === "web" ? "W" : "P",
    label: props.session.participantLabel || props.session.participantUserId || props.session.id
  };
});

const relativeTime = computed(() => {
  if (!props.session.lastActiveAt) return "";
  const diff = Date.now() - props.session.lastActiveAt;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return new Date(props.session.lastActiveAt).toLocaleDateString("zh-CN");
});
</script>

<template>
  <button
    class="list-row flex w-full items-center gap-2.5 px-3 py-2 text-left text-text-primary"
    :class="{ 'is-selected': selected }"
    @click="emit('select')"
  >
    <!-- Type badge -->
    <span
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-small font-bold"
      :class="session.type === 'private' ? 'bg-surface-selected text-text-accent' : 'bg-surface-success text-success'"
    >{{ display.badge }}</span>

    <!-- Main content -->
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <div class="flex items-baseline gap-1.5">
        <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-ui font-medium text-text-secondary">{{ display.label }}</span>
        <span class="shrink-0 text-small text-text-subtle">{{ relativeTime }}</span>
      </div>
      <div class="flex items-center">
        <span
          class="text-small text-text-muted"
          :class="{
            'text-success': session.isGenerating
          }"
        >
          {{ session.isGenerating ? "生成中…" : "空闲" }}
        </span>
      </div>
    </div>

    <div class="relative flex shrink-0 items-center gap-2">
      <span
        v-if="session.isGenerating"
        class="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
      />
      <button
        class="btn-ghost relative z-10"
        title="会话操作"
        @click.stop="emit('openActions', session.id)"
      >
        <Ellipsis :size="14" :stroke-width="2" />
      </button>
    </div>
  </button>
</template>
