<script setup lang="ts">
import { computed, onBeforeUnmount, useTemplateRef } from "vue";
import { X } from "lucide-vue-next";
import { resolveWindowSizing } from "./windowSizing";
import type { WorkbenchRuntimeWindow } from "./useWorkbenchWindows";

const props = defineProps<{
  window: WorkbenchRuntimeWindow;
  isMobile: boolean;
  inactive?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  focus: [];
  move: [position: { x: number; y: number }];
}>();

const surfaceRef = useTemplateRef<HTMLElement>("surface");
const headerRef = useTemplateRef<HTMLElement>("header");

const sizing = computed(() => resolveWindowSizing(props.window.definition.size, props.isMobile));

const surfaceClasses = computed(() => [
  "pointer-events-auto fixed left-1/2 top-1/2 flex min-h-0 min-w-0 flex-col overflow-hidden border border-border-strong bg-surface-panel shadow-[0_22px_70px_rgba(0,0,0,0.45)]",
  sizing.value.className,
  props.inactive ? "window-inactive opacity-75" : "opacity-100"
].join(" "));

const bodyClasses = computed(() => [
  "min-h-0 flex-1 overflow-hidden flex flex-col",
  props.inactive ? "pointer-events-none select-none" : ""
].join(" ").trim());

const showCloseButton = computed(() => (
  props.window.definition.showCloseButton ?? ((props.window.definition.actions?.length ?? 0) === 0)
));

const surfaceStyle = computed(() => ({
  ...sizing.value.style,
  maxHeight: sizing.value.style.maxHeight ?? "calc(100dvh - 2rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))",
  zIndex: String(props.window.order),
  transform: `translate3d(calc(-50% + ${props.window.position.x}px), calc(-50% + ${props.window.position.y}px), 0)`
}));

let dragState: {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
} | null = null;

function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest("button, input, textarea, select, a, [role='button'], [data-window-no-focus]"));
}

function handleSurfacePointerDown(event: PointerEvent) {
  if (isInteractiveTarget(event.target)) {
    return;
  }
  emit("focus");
}

function stopDragging() {
  dragState = null;
  window.removeEventListener("pointermove", handleWindowPointerMove);
  window.removeEventListener("pointerup", handleWindowPointerUp);
  window.removeEventListener("pointercancel", handleWindowPointerUp);
}

function clampPosition(position: { x: number; y: number }) {
  const surfaceWidth = surfaceRef.value?.getBoundingClientRect().width ?? 0;
  const surfaceHeight = surfaceRef.value?.getBoundingClientRect().height ?? 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
  const visibleSide = 56;
  const visibleBottom = 56;
  const visibleTop = 0;

  const minX = visibleSide - (viewportWidth / 2) - (surfaceWidth / 2);
  const maxX = (viewportWidth / 2) - visibleSide + (surfaceWidth / 2);
  const minY = visibleTop - (viewportHeight / 2) + (surfaceHeight / 2);
  const maxY = (viewportHeight / 2) - visibleBottom + (surfaceHeight / 2);

  return {
    x: Math.min(maxX, Math.max(minX, position.x)),
    y: Math.min(maxY, Math.max(minY, position.y))
  };
}

function handleWindowPointerMove(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  emit("move", clampPosition({
    x: dragState.originX + (event.clientX - dragState.startX),
    y: dragState.originY + (event.clientY - dragState.startY)
  }));
}

function handleWindowPointerUp(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }
  stopDragging();
}

function handleHeaderPointerDown(event: PointerEvent) {
  emit("focus");

  if (props.isMobile || props.window.definition.movable === false || isInteractiveTarget(event.target)) {
    return;
  }

  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: props.window.position.x,
    originY: props.window.position.y
  };
  window.addEventListener("pointermove", handleWindowPointerMove);
  window.addEventListener("pointerup", handleWindowPointerUp);
  window.addEventListener("pointercancel", handleWindowPointerUp);
}

onBeforeUnmount(() => {
  stopDragging();
});
</script>

<template>
  <section
    ref="surface"
    class="rounded-xl"
    :class="surfaceClasses"
    :style="surfaceStyle"
    :aria-disabled="inactive ? 'true' : 'false'"
    @focusin="emit('focus')"
    @pointerdown="handleSurfacePointerDown"
  >
    <header ref="header" class="flex items-start gap-3 border-b border-border-default bg-surface-sidebar px-4 py-3 select-none cursor-move" @pointerdown="handleHeaderPointerDown">
      <div class="min-w-0 flex-1">
        <div class="truncate text-ui font-medium text-text-secondary">
          {{ window.definition.title }}
        </div>
        <div v-if="window.definition.description" class="mt-1 text-small leading-5 text-text-muted">
          {{ window.definition.description }}
        </div>
      </div>
      <button v-if="showCloseButton" class="btn-ghost -mr-1 -mt-0.5" title="关闭" type="button" @click="emit('close')">
        <X :size="14" :stroke-width="2" />
      </button>
    </header>

    <div :class="bodyClasses">
      <slot />
    </div>
  </section>
</template>
