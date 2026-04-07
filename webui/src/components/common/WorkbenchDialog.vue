<script setup lang="ts">
import { computed, watch } from "vue";
import { X } from "lucide-vue-next";
import { useVisualViewportInset } from "@/composables/useVisualViewportInset";

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  description?: string;
  widthClass?: string;
  closeOnBackdrop?: boolean;
}>(), {
  description: undefined,
  widthClass: "max-w-lg",
  closeOnBackdrop: true
});

const emit = defineEmits<{
  close: [];
}>();

const { keyboardInsetPx, keyboardInsetStylePx } = useVisualViewportInset();

const backdropStyle = computed(() => ({
  paddingBottom: `calc(1.5rem + ${keyboardInsetStylePx.value})`
}));

const panelStyle = computed(() => ({
  maxHeight: `calc(100dvh - 3rem - ${keyboardInsetStylePx.value})`,
  marginBottom: keyboardInsetPx.value > 0 ? keyboardInsetStylePx.value : "0px"
}));

function onBackdropClick() {
  if (props.closeOnBackdrop) {
    emit("close");
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    emit("close");
  }
}

watch(() => props.open, (open) => {
  if (open) {
    window.addEventListener("keydown", onKeydown);
    document.body.style.overflow = "hidden";
    return;
  }
  window.removeEventListener("keydown", onKeydown);
  document.body.style.overflow = "";
}, { immediate: true });
</script>

<template>
  <teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-[1px]"
      :class="{ 'items-end sm:items-center': keyboardInsetPx > 0 }"
      :style="backdropStyle"
      @click.self="onBackdropClick"
    >
      <div
        class="flex max-h-full w-full flex-col overflow-hidden border border-border-strong bg-surface-panel shadow-[0_22px_70px_rgba(0,0,0,0.45)]"
        :class="widthClass"
        :style="panelStyle"
      >
        <div class="flex items-start gap-3 border-b border-border-default bg-surface-sidebar px-4 py-3">
          <div class="min-w-0 flex-1">
            <div class="truncate text-ui font-medium text-text-secondary">{{ title }}</div>
            <div v-if="description" class="mt-1 text-small leading-5 text-text-muted">{{ description }}</div>
          </div>
          <button class="btn-ghost -mr-1 -mt-0.5" title="关闭" @click="$emit('close')">
            <X :size="14" :stroke-width="2" />
          </button>
        </div>

        <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <slot />
        </div>

        <div
          v-if="$slots.footer"
          class="flex items-center justify-end gap-2 border-t border-border-default bg-surface-sidebar px-4 py-3"
        >
          <slot name="footer" />
        </div>
      </div>
    </div>
  </teleport>
</template>
