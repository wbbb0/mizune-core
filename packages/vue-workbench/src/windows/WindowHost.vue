<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { useWorkbenchWindows } from "./useWorkbenchWindows";
import type {
  WorkbenchWindowBounds,
  WorkbenchWindowDialogController,
  WorkbenchWindowMaximizePayload,
  WorkbenchWindowResult
} from "./types";
import DialogRenderer from "./DialogRenderer.vue";
import WindowSurface from "./WindowSurface.vue";

const props = defineProps<{
  isMobile: boolean;
}>();

const { desktopWindows, mobileWindows, close, focus, move, setBounds, setMaximized, get } = useWorkbenchWindows();

const renderedWindows = computed(() => (props.isMobile ? mobileWindows.value : desktopWindows.value));
const activeModalWindow = computed(() => (
  [...renderedWindows.value].reverse().find((window) => window.definition.modal) ?? null
));
const dialogControllers = new Map<string, WorkbenchWindowDialogController>();

const inactiveWindowIds = computed(() => {
  const ids = new Set<string>();
  for (const window of desktopWindows.value) {
    if (window.parentId) {
      ids.add(window.parentId);
    }
  }
  return ids;
});

function setDialogRendererRef(windowId: string, controller: unknown) {
  if (
    controller
    && typeof controller === "object"
    && "snapshotValues" in controller
    && typeof controller.snapshotValues === "function"
  ) {
    dialogControllers.set(windowId, controller as WorkbenchWindowDialogController);
    return;
  }
  dialogControllers.delete(windowId);
}

function resolveWindowValues(windowId: string) {
  return dialogControllers.get(windowId)?.snapshotValues() ?? {};
}

function handleClose(windowId: string) {
  if (!get(windowId)) {
    return;
  }
  close(windowId, {
    reason: "close",
    values: resolveWindowValues(windowId)
  });
  dialogControllers.delete(windowId);
}

function handleFocus(windowId: string) {
  const topWindow = renderedWindows.value[renderedWindows.value.length - 1];
  if (topWindow?.id === windowId) {
    return;
  }
  focus(windowId);
}

function handleMove(windowId: string, position: { x: number; y: number }) {
  move(windowId, position);
}

function handleBounds(windowId: string, bounds: WorkbenchWindowBounds) {
  setBounds(windowId, bounds);
}

function handleMaximize(windowId: string, payload: WorkbenchWindowMaximizePayload) {
  setMaximized(windowId, payload);
}

function handleResolve(windowId: string, result: WorkbenchWindowResult<unknown, Record<string, unknown>>) {
  if (!get(windowId)) {
    dialogControllers.delete(windowId);
    return;
  }
  close(windowId, result);
  dialogControllers.delete(windowId);
}

function handleBackdropClick() {
  const activeWindow = activeModalWindow.value;
  if (!activeWindow || !activeWindow.definition.closeOnBackdrop) {
    return;
  }
  close(activeWindow.id, {
    reason: "dismiss",
    values: resolveWindowValues(activeWindow.id)
  });
  dialogControllers.delete(activeWindow.id);
}

function handleWindowKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") {
    return;
  }

  const activeWindow = renderedWindows.value[renderedWindows.value.length - 1];
  if (!activeWindow || !activeWindow.definition.closeOnEscape) {
    return;
  }

  event.preventDefault();
  close(activeWindow.id, {
    reason: "dismiss",
    values: resolveWindowValues(activeWindow.id)
  });
  dialogControllers.delete(activeWindow.id);
}

onMounted(() => {
  window.addEventListener("keydown", handleWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleWindowKeydown);
});
</script>

<template>
  <div class="pointer-events-none fixed inset-0 z-60 overflow-hidden">
    <div
      v-if="activeModalWindow"
      data-test="window-backdrop"
      class="pointer-events-auto fixed inset-0"
      :style="{ zIndex: '1' }"
      @click="handleBackdropClick"
    />
    <WindowSurface
      v-for="window in renderedWindows"
      :key="window.id"
      :window="window"
      :is-mobile="isMobile"
      :inactive="inactiveWindowIds.has(window.id)"
      @focus="handleFocus(window.id)"
      @move="handleMove(window.id, $event)"
      @bounds="handleBounds(window.id, $event)"
      @maximize="handleMaximize(window.id, $event)"
      @close="handleClose(window.id)"
    >
      <DialogRenderer
        :ref="(controller) => setDialogRendererRef(window.id, controller)"
        :window-id="window.id"
        :definition="window.definition"
        @resolve="handleResolve(window.id, $event)"
      />
    </WindowSurface>
  </div>
</template>
