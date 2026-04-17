<script setup lang="ts" generic="TItem extends { id: string }">
import { ref, watch, nextTick } from "vue";
import { VList } from "virtua/vue";
import { Loader } from "lucide-vue-next";

const props = defineProps<{
  items: TItem[];
  hasMore: boolean;
  loadingMore: boolean;
}>();

const emit = defineEmits<{
  "load-more": [];
}>();

const listRef = ref<InstanceType<typeof VList>>();
const lastScrollOffset = ref(0);

function getKey(item: TItem): string {
  return item.id;
}

function onScroll(offset: number) {
  lastScrollOffset.value = offset;
  if (!listRef.value || !props.hasMore || props.loadingMore) return;
  const distFromBottom =
    listRef.value.scrollSize - listRef.value.viewportSize - offset;
  if (distFromBottom < 200) {
    emit("load-more");
  }
}

// 初始加载完成后滚到顶部（最新消息）
watch(
  () => props.items.length,
  (newLen, oldLen) => {
    if (oldLen === 0 && newLen > 0) {
      nextTick(() => listRef.value?.scrollToIndex(0, { align: "start" }));
    }
  }
);

// SSE 新条目插入顶部时，若用户在顶部附近则跟随
watch(
  () => props.items[0]?.id,
  (newId, oldId) => {
    if (!oldId || !newId || newId === oldId) return;
    if (lastScrollOffset.value < 150) {
      nextTick(() => listRef.value?.scrollToIndex(0, { align: "start" }));
    }
  }
);

function scrollToTop() {
  listRef.value?.scrollToIndex(0, { align: "start" });
}

defineExpose({ scrollToTop });
</script>

<template>
  <div class="flex min-h-0 flex-col overflow-hidden">
    <VList
      ref="listRef"
      class="scrollbar-thin min-h-0 flex-1 overflow-x-hidden"
      :data="items"
      :get-key="getKey"
      @scroll="onScroll"
    >
      <template #default="{ item }">
        <slot name="item" :item="item" />
      </template>
    </VList>
    <!-- 底部状态行（最旧一侧）：仅在有内容时显示 -->
    <div
      v-if="loadingMore || (!hasMore && items.length > 0)"
      class="flex shrink-0 items-center justify-center py-2"
    >
      <Loader
        v-if="loadingMore"
        :size="12"
        :stroke-width="2"
        class="spin text-text-muted"
      />
      <span v-else class="text-small text-text-subtle">已加载全部</span>
    </div>
  </div>
</template>
