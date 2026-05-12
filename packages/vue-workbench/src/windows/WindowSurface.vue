<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, useTemplateRef } from "vue";
import { X } from "lucide-vue-next";
import { resolveWindowSizing } from "./windowSizing";
import type {
  WorkbenchWindowBounds,
  WorkbenchWindowMaximizePayload,
  WorkbenchWindowSizedBounds,
  WorkbenchWindowSizePx
} from "./types";
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
  bounds: [bounds: WorkbenchWindowBounds];
  maximize: [payload: WorkbenchWindowMaximizePayload];
}>();

const surfaceRef = useTemplateRef<HTMLElement>("surface");

const sizing = computed(() => resolveWindowSizing(props.window.definition.size, props.isMobile));
const minWindowSize: WorkbenchWindowSizePx = {
  width: 320,
  height: 180
};
const viewportMargin = 16;

const surfaceClasses = computed(() => [
  "pointer-events-auto fixed left-1/2 top-1/2 flex min-h-0 min-w-0 flex-col overflow-hidden border border-border-strong bg-surface-panel shadow-[0_22px_70px_rgba(0,0,0,0.45)]",
  sizing.value.className,
  props.inactive ? "window-inactive" : "opacity-100"
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
  ...(props.window.sizePx ? {
    width: `${props.window.sizePx.width}px`,
    height: `${props.window.sizePx.height}px`,
    maxWidth: "calc(100vw - 2rem - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))"
  } : {}),
  maxHeight: sizing.value.style.maxHeight ?? "calc(100dvh - 2rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))",
  zIndex: String(props.window.order * 2),
  transform: `translate3d(calc(-50% + ${props.window.position.x}px), calc(-50% + ${props.window.position.y}px), 0)`
}));

const canResize = computed(() => !props.isMobile && props.window.definition.resizable !== false);
const headerCursorClass = computed(() => (
  props.isMobile || props.window.definition.movable === false ? "" : "cursor-move"
));

type ResizeDirection = {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
};

const resizeHandles: Array<{
  key: string;
  direction: ResizeDirection;
  className: string;
}> = [
  { key: "n", direction: { x: 0, y: -1 }, className: "left-2 right-2 top-0 h-2 -translate-y-1/2 cursor-n-resize" },
  { key: "s", direction: { x: 0, y: 1 }, className: "bottom-0 left-2 right-2 h-2 translate-y-1/2 cursor-s-resize" },
  { key: "w", direction: { x: -1, y: 0 }, className: "bottom-2 left-0 top-2 w-2 -translate-x-1/2 cursor-w-resize" },
  { key: "e", direction: { x: 1, y: 0 }, className: "bottom-2 right-0 top-2 w-2 translate-x-1/2 cursor-e-resize" },
  { key: "nw", direction: { x: -1, y: -1 }, className: "left-0 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 cursor-nw-resize" },
  { key: "ne", direction: { x: 1, y: -1 }, className: "right-0 top-0 h-2 w-2 translate-x-1/2 -translate-y-1/2 cursor-ne-resize" },
  { key: "sw", direction: { x: -1, y: 1 }, className: "bottom-0 left-0 h-2 w-2 -translate-x-1/2 translate-y-1/2 cursor-sw-resize" },
  { key: "se", direction: { x: 1, y: 1 }, className: "bottom-0 right-0 h-2 w-2 translate-x-1/2 translate-y-1/2 cursor-se-resize" }
];

let dragState: {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
} | null = null;

let resizeState: {
  pointerId: number;
  startX: number;
  startY: number;
  direction: ResizeDirection;
  originBounds: WorkbenchWindowSizedBounds;
} | null = null;

function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest("button, input, textarea, select, a, [role='button'], [data-window-no-focus]"));
}

function handleSurfacePointerDown(event: PointerEvent) {
  if (props.inactive) {
    return;
  }
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

function stopResizing() {
  resizeState = null;
  window.removeEventListener("pointermove", handleWindowResizePointerMove);
  window.removeEventListener("pointerup", handleWindowResizePointerUp);
  window.removeEventListener("pointercancel", handleWindowResizePointerUp);
}

function getViewportSize() {
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 1024,
    height: window.innerHeight || document.documentElement.clientHeight || 768
  };
}

function getMaxWindowSize() {
  const viewport = getViewportSize();
  return {
    width: Math.max(minWindowSize.width, viewport.width - viewportMargin * 2),
    height: Math.max(minWindowSize.height, viewport.height - viewportMargin * 2)
  };
}

function resolveCurrentSize(): WorkbenchWindowSizePx {
  const rect = surfaceRef.value?.getBoundingClientRect();
  return {
    width: props.window.sizePx?.width ?? rect?.width ?? minWindowSize.width,
    height: props.window.sizePx?.height ?? rect?.height ?? minWindowSize.height
  };
}

function resolveCurrentBounds(): WorkbenchWindowSizedBounds {
  return {
    position: { ...props.window.position },
    sizePx: resolveCurrentSize()
  };
}

function clampSize(size: WorkbenchWindowSizePx) {
  const maxSize = getMaxWindowSize();
  return {
    width: Math.min(maxSize.width, Math.max(minWindowSize.width, Math.round(size.width))),
    height: Math.min(maxSize.height, Math.max(minWindowSize.height, Math.round(size.height)))
  };
}

function clampPosition(position: { x: number; y: number }) {
  const currentSize = resolveCurrentSize();
  const surfaceWidth = currentSize.width;
  const surfaceHeight = currentSize.height;
  const { width: viewportWidth, height: viewportHeight } = getViewportSize();
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

function resolveBoundsEdges(bounds: WorkbenchWindowSizedBounds) {
  const viewport = getViewportSize();
  const left = (viewport.width / 2) + bounds.position.x - (bounds.sizePx.width / 2);
  const top = (viewport.height / 2) + bounds.position.y - (bounds.sizePx.height / 2);
  return {
    left,
    top,
    right: left + bounds.sizePx.width,
    bottom: top + bounds.sizePx.height
  };
}

function createBoundsFromEdges(
  edges: { left: number; top: number; right: number; bottom: number },
  originEdges: { left: number; top: number; right: number; bottom: number },
  direction: ResizeDirection
) {
  const viewport = getViewportSize();
  const sizePx = clampSize({
    width: edges.right - edges.left,
    height: edges.bottom - edges.top
  });
  const left = direction.x < 0 && edges.right - edges.left !== sizePx.width
    ? originEdges.right - sizePx.width
    : edges.left;
  const top = direction.y < 0 && edges.bottom - edges.top !== sizePx.height
    ? originEdges.bottom - sizePx.height
    : edges.top;

  return {
    position: {
      x: Math.round(left + (sizePx.width / 2) - (viewport.width / 2)),
      y: Math.round(top + (sizePx.height / 2) - (viewport.height / 2))
    },
    sizePx
  };
}

function clampBounds(bounds: WorkbenchWindowSizedBounds): WorkbenchWindowSizedBounds {
  const viewport = getViewportSize();
  const sizePx = clampSize(bounds.sizePx);
  const minCenterX = viewportMargin + (sizePx.width / 2) - (viewport.width / 2);
  const maxCenterX = (viewport.width / 2) - viewportMargin - (sizePx.width / 2);
  const minCenterY = viewportMargin + (sizePx.height / 2) - (viewport.height / 2);
  const maxCenterY = (viewport.height / 2) - viewportMargin - (sizePx.height / 2);

  return {
    position: {
      x: Math.round(Math.min(maxCenterX, Math.max(minCenterX, bounds.position.x))),
      y: Math.round(Math.min(maxCenterY, Math.max(minCenterY, bounds.position.y)))
    },
    sizePx
  };
}

function resolveMaximizedBounds(): WorkbenchWindowSizedBounds {
  const viewport = getViewportSize();
  const sizePx = getMaxWindowSize();
  return {
    position: {
      x: 0,
      y: 0
    },
    sizePx: {
      width: Math.min(sizePx.width, Math.max(minWindowSize.width, viewport.width - viewportMargin * 2)),
      height: Math.min(sizePx.height, Math.max(minWindowSize.height, viewport.height - viewportMargin * 2))
    }
  };
}

function restoreFromMaximize() {
  if (!props.window.maximized || !props.window.restoreBounds) {
    return null;
  }
  const restored = clampBounds({
    position: props.window.restoreBounds.position,
    sizePx: props.window.restoreBounds.sizePx ?? resolveCurrentSize()
  });
  emit("maximize", {
    maximized: false,
    bounds: restored
  });
  return restored;
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
  if (event.button !== 0) {
    return;
  }
  if (props.inactive) {
    if (props.isMobile || props.window.definition.movable === false || isInteractiveTarget(event.target)) {
      return;
    }
    const restored = restoreFromMaximize();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: restored?.position.x ?? props.window.position.x,
      originY: restored?.position.y ?? props.window.position.y
    };
    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerUp);
    return;
  }

  emit("focus");

  if (props.isMobile || props.window.definition.movable === false || isInteractiveTarget(event.target)) {
    return;
  }

  const restored = restoreFromMaximize();
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: restored?.position.x ?? props.window.position.x,
    originY: restored?.position.y ?? props.window.position.y
  };
  window.addEventListener("pointermove", handleWindowPointerMove);
  window.addEventListener("pointerup", handleWindowPointerUp);
  window.addEventListener("pointercancel", handleWindowPointerUp);
}

function handleWindowResizePointerMove(event: PointerEvent) {
  if (!resizeState || event.pointerId !== resizeState.pointerId) {
    return;
  }

  const deltaX = event.clientX - resizeState.startX;
  const deltaY = event.clientY - resizeState.startY;
  const originEdges = resolveBoundsEdges(resizeState.originBounds);
  const nextEdges = {
    left: resizeState.direction.x < 0 ? originEdges.left + deltaX : originEdges.left,
    right: resizeState.direction.x > 0 ? originEdges.right + deltaX : originEdges.right,
    top: resizeState.direction.y < 0 ? originEdges.top + deltaY : originEdges.top,
    bottom: resizeState.direction.y > 0 ? originEdges.bottom + deltaY : originEdges.bottom
  };

  emit("bounds", clampBounds(createBoundsFromEdges(nextEdges, originEdges, resizeState.direction)));
}

function handleWindowResizePointerUp(event: PointerEvent) {
  if (!resizeState || event.pointerId !== resizeState.pointerId) {
    return;
  }
  stopResizing();
}

function handleResizePointerDown(direction: ResizeDirection, event: PointerEvent) {
  if (!canResize.value || event.button !== 0) {
    return;
  }

  if (!props.inactive) {
    emit("focus");
  }
  event.preventDefault();
  event.stopPropagation();
  const restored = restoreFromMaximize();
  resizeState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    direction,
    originBounds: restored ?? resolveCurrentBounds()
  };
  window.addEventListener("pointermove", handleWindowResizePointerMove);
  window.addEventListener("pointerup", handleWindowResizePointerUp);
  window.addEventListener("pointercancel", handleWindowResizePointerUp);
}

function handleHeaderDoubleClick(event: MouseEvent) {
  if (!canResize.value || props.inactive || isInteractiveTarget(event.target)) {
    return;
  }

  event.preventDefault();
  if (props.window.maximized && props.window.restoreBounds) {
    emit("maximize", {
      maximized: false,
      bounds: clampBounds({
        position: props.window.restoreBounds.position,
        sizePx: props.window.restoreBounds.sizePx ?? resolveCurrentSize()
      })
    });
    return;
  }

  emit("maximize", {
    maximized: true,
    bounds: resolveMaximizedBounds(),
    restoreBounds: resolveCurrentBounds()
  });
}

function clampWindowToViewport() {
  if (props.isMobile) {
    return;
  }

  if (props.window.maximized) {
    emit("maximize", {
      maximized: true,
      bounds: resolveMaximizedBounds(),
      restoreBounds: props.window.restoreBounds ?? resolveCurrentBounds()
    });
    return;
  }

  const nextBounds = clampBounds(resolveCurrentBounds());
  if (!props.window.sizePx) {
    if (
      nextBounds.position.x === props.window.position.x
      && nextBounds.position.y === props.window.position.y
    ) {
      return;
    }
    emit("move", nextBounds.position);
    return;
  }

  if (
    nextBounds.position.x === props.window.position.x
    && nextBounds.position.y === props.window.position.y
    && nextBounds.sizePx.width === props.window.sizePx.width
    && nextBounds.sizePx.height === props.window.sizePx.height
  ) {
    return;
  }

  emit("bounds", nextBounds);
}

onMounted(() => {
  window.addEventListener("resize", clampWindowToViewport);
});

onBeforeUnmount(() => {
  stopDragging();
  stopResizing();
  window.removeEventListener("resize", clampWindowToViewport);
});

function handleFocusIn() {
  if (props.inactive) {
    return;
  }
  emit("focus");
}
</script>

<template>
  <section
    ref="surface"
    class="rounded-xl"
    :class="surfaceClasses"
    :style="surfaceStyle"
    :aria-disabled="inactive ? 'true' : 'false'"
    @focusin="handleFocusIn"
    @pointerdown="handleSurfacePointerDown"
  >
    <header
      class="flex items-start gap-3 border-b border-border-default bg-surface-sidebar px-4 py-3 select-none"
      :class="headerCursorClass"
      @dblclick="handleHeaderDoubleClick"
      @pointerdown="handleHeaderPointerDown"
    >
      <div class="min-w-0 flex-1">
        <div class="truncate text-ui font-medium text-text-secondary">
          {{ window.definition.title }}
        </div>
        <div v-if="window.definition.description" class="mt-1 text-small leading-5 text-text-muted">
          {{ window.definition.description }}
        </div>
      </div>
      <button v-if="showCloseButton" class="btn-ghost -mr-1 -mt-0.5" title="关闭" type="button" :disabled="inactive" @click="emit('close')">
        <X :size="14" :stroke-width="2" />
      </button>
    </header>

    <div :class="bodyClasses">
      <slot />
    </div>
    <template v-if="canResize">
      <div
        v-for="handle in resizeHandles"
        :key="handle.key"
        class="absolute z-10 bg-transparent"
        :class="handle.className"
        data-window-no-focus
        :data-window-resize-handle="handle.key"
        @pointerdown="handleResizePointerDown(handle.direction, $event)"
      />
    </template>
  </section>
</template>

<style scoped>
.window-inactive {
  filter: contrast(0.74) brightness(0.94);
}
</style>
