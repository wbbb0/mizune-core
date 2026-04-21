<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, watch, type ComponentPublicInstance } from "vue";
import MenuList from "@/components/workbench/menu/MenuList.vue";
import { useMenuRuntime } from "@/composables/workbench/menu/useMenuRuntime";

const { openMenus, closeAllMenus, closeMenu } = useMenuRuntime();

const surfaceElements = new Map<string, HTMLElement>();

const menuOffsets = computed(() =>
  Object.fromEntries(
    openMenus.value.map((menu, index) => [
      menu.id,
      resolveMenuPosition(menu, index)
    ])
  )
);

function setSurfaceElement(menuId: string, element: Element | ComponentPublicInstance | null) {
  const resolvedElement =
    element instanceof HTMLElement
      ? element
      : element && "$el" in element && element.$el instanceof HTMLElement
        ? element.$el
        : null;

  if (!(resolvedElement instanceof HTMLElement)) {
    surfaceElements.delete(menuId);
    return;
  }

  surfaceElements.set(menuId, resolvedElement);
}

function resolveMenuPosition(menu: (typeof openMenus.value)[number], index: number) {
  const fallbackWidth = 176;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 768;
  let left = 12;
  let top = 56;

  if ("x" in menu.anchor) {
    left = menu.anchor.x;
    top = menu.anchor.y;
  } else if (menu.anchor.element) {
    const rect = menu.anchor.element.getBoundingClientRect();
    left = menu.parentId ? rect.right + 4 : rect.left;
    top = menu.parentId ? rect.top : rect.bottom + 4;
  } else {
    left = 12 + index * 220;
    top = 56 + index * 12;
  }

  left = Math.max(8, Math.min(left, viewportWidth - fallbackWidth - 8));
  top = Math.max(8, Math.min(top, viewportHeight - 120));

  return {
    left: `${left}px`,
    top: `${top}px`
  };
}

function focusLatestMenuItem() {
  const latestMenu = openMenus.value.at(-1);
  if (!latestMenu) {
    return;
  }

  const surface = surfaceElements.get(latestMenu.id);
  const firstItem = surface?.querySelector<HTMLElement>("[data-menu-item='true']");
  firstItem?.focus();
}

function handlePointerDown(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    closeAllMenus();
    return;
  }

  if (target.closest("[data-menu-surface]") || target.closest("[data-menu-trigger]")) {
    return;
  }

  closeAllMenus();
}

function moveFocus(step: number) {
  const latestMenu = openMenus.value.at(-1);
  if (!latestMenu) {
    return;
  }

  const surface = surfaceElements.get(latestMenu.id);
  const items = surface ? Array.from(surface.querySelectorAll<HTMLElement>("[data-menu-item='true']")) : [];
  if (items.length === 0) {
    return;
  }

  const activeIndex = items.findIndex((item) => item === document.activeElement);
  const nextIndex = activeIndex < 0 ? 0 : (activeIndex + step + items.length) % items.length;
  items[nextIndex]?.focus();
}

function handleKeydown(event: KeyboardEvent) {
  if (openMenus.value.length === 0) {
    return;
  }

  if (event.key === "Escape") {
    closeAllMenus();
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveFocus(1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveFocus(-1);
    return;
  }

  if (event.key === "ArrowLeft" && openMenus.value.length > 1) {
    event.preventDefault();
    closeMenu(openMenus.value.at(-1)?.id ?? "");
    nextTick(() => focusLatestMenuItem());
    return;
  }

  if (event.key === "ArrowRight" || event.key === "Enter") {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLButtonElement)) {
      return;
    }

    if (activeElement.dataset.menuKind === "submenu") {
      event.preventDefault();
      activeElement.click();
    }
  }
}

watch(
  () => openMenus.value.map((menu) => menu.id),
  async () => {
    await nextTick();
    focusLatestMenuItem();
  }
);

onMounted(() => {
  window.addEventListener("pointerdown", handlePointerDown, true);
  window.addEventListener("keydown", handleKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", handlePointerDown, true);
  window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <div class="pointer-events-none fixed inset-0 z-50">
    <div
      v-for="menu in openMenus"
      :key="menu.id"
      :ref="(element) => setSurfaceElement(menu.id, element)"
      class="pointer-events-auto absolute rounded-md border border-border-default bg-surface-panel shadow-xl"
      data-menu-surface="true"
      :style="menuOffsets[menu.id]"
    >
      <MenuList :items="menu.items" :menu-id="menu.id" :source="menu.source" />
    </div>
  </div>
</template>
