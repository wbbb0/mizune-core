<script setup lang="ts">
import { computed, defineComponent, h, onBeforeUnmount, useSlots, watch } from "vue";
import { useWorkbenchWindows } from "@/composables/workbench/useWorkbenchWindows";

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  description?: string;
  variant?: "content" | "fullscreen";
  widthClass?: string;
  panelClass?: string;
  bodyClass?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
}>(), {
  description: undefined,
  variant: "content",
  widthClass: "max-w-lg",
  panelClass: "",
  bodyClass: "",
  closeOnBackdrop: true,
  closeOnEscape: true
});

const emit = defineEmits<{
  close: [];
}>();

const slots = useSlots();
const windows = useWorkbenchWindows();

let activeWindowId: string | null = null;
let closingFromSyncWindowId: string | null = null;

const dialogSize = computed(() => (props.variant === "fullscreen" ? "full" : "md"));

const dialogContent = defineComponent({
  name: "WorkbenchDialogCompatContent",
  setup() {
    return () => [
      h(
        "div",
        {
          class: [
            props.variant === "fullscreen"
              ? "scrollbar-thin min-h-0 flex-1 overflow-y-auto"
              : "scrollbar-thin overflow-y-auto",
            props.bodyClass
          ].filter(Boolean).join(" ").trim()
        },
        slots.default ? slots.default() : []
      ),
      slots.footer
        ? h(
            "div",
            {
              class: "flex items-center justify-end gap-2 border-t border-border-default bg-surface-sidebar px-4 py-3"
            },
            slots.footer()
          )
        : null
    ];
  }
});

function requestClose() {
  emit("close");
}

function attachWindow() {
  const runtimeWindow = windows.openSync({
    id: activeWindowId ?? undefined,
    kind: "dialog",
    title: props.title,
    description: props.description,
    size: dialogSize.value,
    closeOnBackdrop: props.closeOnBackdrop,
    closeOnEscape: props.closeOnEscape,
    blocks: [
      {
        kind: "component",
        component: dialogContent
      }
    ]
  });
  activeWindowId = runtimeWindow.id;
}

function detachWindow() {
  if (!activeWindowId) {
    return;
  }
  closingFromSyncWindowId = activeWindowId;
  windows.close(activeWindowId, {
    reason: "close",
    values: {}
  });
  activeWindowId = null;
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      attachWindow();
      return;
    }

    detachWindow();
  },
  { immediate: true }
);

watch(
  () => [props.title, props.description, props.variant, props.closeOnBackdrop, props.closeOnEscape],
  () => {
    if (!props.open || !activeWindowId) {
      return;
    }
    detachWindow();
    attachWindow();
  }
);

watch(
  () => windows.snapshot().some((windowItem) => windowItem.id === activeWindowId),
  (present) => {
    if (present || !activeWindowId) {
      return;
    }

    const closedWindowId = activeWindowId;
    activeWindowId = null;

    if (closingFromSyncWindowId === closedWindowId) {
      closingFromSyncWindowId = null;
      return;
    }

    requestClose();
  }
);

onBeforeUnmount(() => {
  if (activeWindowId) {
    windows.close(activeWindowId, {
      reason: "close",
      values: {}
    });
    activeWindowId = null;
  }
});
</script>

<template>
  <div class="hidden" aria-hidden="true" />
</template>
