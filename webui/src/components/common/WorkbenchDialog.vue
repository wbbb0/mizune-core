<script setup lang="ts">
import { computed, watch } from "vue";
import { X } from "lucide-vue-next";

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  description?: string;
  variant?: "content" | "fullscreen";
  widthClass?: string;
  panelClass?: string;
  bodyClass?: string;
  closeOnBackdrop?: boolean;
}>(), {
  description: undefined,
  variant: "content",
  widthClass: "max-w-lg",
  panelClass: "",
  bodyClass: "",
  closeOnBackdrop: true
});

const emit = defineEmits<{
  close: [];
}>();

const backdropStyle = computed(() => ({
  paddingTop: "max(1rem, env(safe-area-inset-top, 0px))",
  paddingRight: "max(1rem, env(safe-area-inset-right, 0px))",
  paddingBottom: "max(1rem, env(safe-area-inset-bottom, 0px))",
  paddingLeft: "max(1rem, env(safe-area-inset-left, 0px))"
}));

const panelStyle = computed(() => (
  props.variant === "fullscreen"
    ? {
        width: "min(100%, calc(100vw - 2rem - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)))",
        height: "calc(100dvh - 2rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))"
      }
    : {
        maxHeight: "calc(100dvh - 2rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))"
      }
));

const panelClasses = computed(() => (
  props.variant === "fullscreen"
    ? `h-full max-h-full ${props.panelClass}`.trim()
    : `${props.widthClass} ${props.panelClass}`.trim()
));

const bodyClasses = computed(() => (
  props.variant === "fullscreen"
    ? `scrollbar-thin min-h-0 flex-1 overflow-y-auto ${props.bodyClass}`.trim()
    : `scrollbar-thin overflow-y-auto ${props.bodyClass}`.trim()
));

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
      :style="backdropStyle"
      @click.self="onBackdropClick"
    >
      <div
        class="flex max-h-full w-full flex-col overflow-hidden border border-border-strong bg-surface-panel shadow-[0_22px_70px_rgba(0,0,0,0.45)]"
        :class="panelClasses"
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

        <div :class="bodyClasses">
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
