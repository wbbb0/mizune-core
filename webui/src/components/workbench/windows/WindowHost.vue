<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { useUiStore } from "@/stores/ui";
import { useWorkbenchWindows } from "@/composables/workbench/useWorkbenchWindows";
import type { WindowDialogController, WindowResult } from "./types";
import DialogRenderer from "./DialogRenderer.vue";
import WindowSurface from "./WindowSurface.vue";

const ui = useUiStore();
const { desktopWindows, mobileWindows, close, focus, move } = useWorkbenchWindows();

const renderedWindows = computed(() => (ui.isMobile ? mobileWindows.value : desktopWindows.value));
const activeModalWindow = computed(() => (
  [...renderedWindows.value].reverse().find((window) => window.definition.modal) ?? null
));
const dialogControllers = new Map<string, WindowDialogController>();

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
    dialogControllers.set(windowId, controller as WindowDialogController);
    return;
  }
  dialogControllers.delete(windowId);
}

function resolveWindowValues(windowId: string) {
  return dialogControllers.get(windowId)?.snapshotValues() ?? {};
}

function handleClose(windowId: string) {
  close(windowId, {
    reason: "close",
    values: resolveWindowValues(windowId)
  });
  dialogControllers.delete(windowId);
}

function handleFocus(windowId: string) {
  focus(windowId);
}

function handleMove(windowId: string, position: { x: number; y: number }) {
  move(windowId, position);
}

function handleResolve(windowId: string, result: WindowResult<unknown, Record<string, unknown>>) {
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
      class="pointer-events-auto fixed inset-0 bg-black/30 backdrop-blur-xs"
      :style="{ zIndex: String(Math.max(0, activeModalWindow.order - 1)) }"
      @click="handleBackdropClick"
    />
    <WindowSurface
      v-for="window in renderedWindows"
      :key="window.id"
      :window="window"
      :is-mobile="ui.isMobile"
      :inactive="inactiveWindowIds.has(window.id)"
      @focus="handleFocus(window.id)"
      @move="handleMove(window.id, $event)"
      @close="handleClose(window.id)"
    >
      <DialogRenderer
        v-if="window.definition.schema || window.definition.actions"
        :ref="(controller) => setDialogRendererRef(window.id, controller)"
        :window-id="window.id"
        :definition="window.definition"
        @resolve="handleResolve(window.id, $event)"
      />
      <div v-else class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-3 text-small leading-5 text-text-secondary">
        <template v-if="window.definition.blocks && window.definition.blocks.length > 0">
          <template v-for="(block, index) in window.definition.blocks" :key="index">
            <p v-if="block.kind === 'text'" class="whitespace-pre-wrap">{{ block.content }}</p>
            <hr v-else-if="block.kind === 'separator'" class="my-3 border-border-default" />
            <component v-else :is="block.component" v-bind="block.props ?? {}" />
          </template>
        </template>
        <p v-else class="text-text-muted">暂无窗口内容</p>
      </div>
    </WindowSurface>
  </div>
</template>
