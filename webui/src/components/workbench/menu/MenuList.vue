<script setup lang="ts">
import type { MenuNode, MenuSource } from "@/components/workbench/menu/types";
import { useMenuRuntime } from "@/composables/workbench/menu/useMenuRuntime";

const props = defineProps<{
  items: MenuNode[];
  menuId: string;
  source: MenuSource;
}>();

const { openSubmenu, closeAllMenus } = useMenuRuntime();

function onSelect(item: MenuNode, event: MouseEvent) {
  if (item.kind === "action") {
    item.onSelect();
    closeAllMenus();
    return;
  }

  if (item.kind === "toggle") {
    item.onToggle(!item.checked);
    closeAllMenus();
    return;
  }

  if (item.kind === "radio") {
    item.onSelect();
    closeAllMenus();
    return;
  }

  if (item.kind === "submenu") {
    openSubmenu({
      id: `${props.menuId}:${item.id}`,
      parentId: props.menuId,
      source: props.source,
      anchor: { element: event.currentTarget as HTMLElement | null },
      items: item.children
    });
  }
}

function onHover(item: MenuNode, event: MouseEvent) {
  if (item.kind !== "submenu") {
    return;
  }

  openSubmenu({
    id: `${props.menuId}:${item.id}`,
    parentId: props.menuId,
    source: props.source,
    anchor: { element: event.currentTarget as HTMLElement | null },
    items: item.children
  });
}
</script>

<template>
  <div class="flex min-w-44 flex-col gap-0.5 p-0.5">
    <template v-for="item in items" :key="item.id">
      <button
        v-if="item.kind === 'action' || item.kind === 'submenu'"
        class="flex min-h-8 w-full items-center justify-between rounded-md px-2.5 py-1 text-left text-[13px] text-text-primary transition-colors duration-120 outline-none hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:text-text-primary"
        data-menu-item="true"
        :data-menu-kind="item.kind"
        @click="onSelect(item, $event)"
        @mouseenter="onHover(item, $event)"
      >
        <span>{{ item.label }}</span>
        <span v-if="item.kind === 'submenu'">›</span>
      </button>
      <div v-else-if="item.kind === 'separator'" class="my-1.5 border-t border-border-default/80" />
      <button
        v-else-if="item.kind === 'toggle'"
        class="flex min-h-8 w-full items-center justify-between rounded-md px-2.5 py-1 text-left text-[13px] text-text-primary transition-colors duration-120 outline-none hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:text-text-primary"
        data-menu-item="true"
        :data-menu-kind="item.kind"
        @click="onSelect(item, $event)"
      >
        <span>{{ item.label }}</span>
        <span>{{ item.checked ? "✓" : "" }}</span>
      </button>
      <button
        v-else-if="item.kind === 'radio'"
        class="flex min-h-8 w-full items-center justify-between rounded-md px-2.5 py-1 text-left text-[13px] text-text-primary transition-colors duration-120 outline-none hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:text-text-primary"
        data-menu-item="true"
        :data-menu-kind="item.kind"
        @click="onSelect(item, $event)"
      >
        <span>{{ item.label }}</span>
        <span>{{ item.checked ? "●" : "○" }}</span>
      </button>
      <div v-else-if="item.kind === 'component'" class="px-1">
        <component :is="item.component" v-bind="item.props" />
      </div>
      <div v-else-if="item.kind === 'group'" class="flex flex-col">
        <div v-if="item.label" class="px-2.5 pb-1 pt-1 text-[11px] text-text-muted">
          {{ item.label }}
        </div>
        <MenuList :items="item.children" :menu-id="`${menuId}:${item.id}`" :source="source" />
      </div>
    </template>
  </div>
</template>
