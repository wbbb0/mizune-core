import { ref } from "vue";
import type { MenuStackEntry } from "@/components/workbench/menu/types";

const openMenus = ref<MenuStackEntry[]>([]);

function openMenu(entry: MenuStackEntry) {
  openMenus.value = [entry];
}

function openSubmenu(entry: MenuStackEntry) {
  const parentIndex = entry.parentId ? openMenus.value.findIndex((menu) => menu.id === entry.parentId) : -1;
  if (parentIndex < 0) {
    openMenus.value = [...openMenus.value.filter((menu) => menu.id !== entry.id), entry];
    return;
  }

  openMenus.value = [...openMenus.value.slice(0, parentIndex + 1), entry];
}

function closeMenu(id: string) {
  const closeIndex = openMenus.value.findIndex((menu) => menu.id === id);
  if (closeIndex < 0) {
    return;
  }

  openMenus.value = openMenus.value.slice(0, closeIndex);
}

function closeAllMenus() {
  openMenus.value = [];
}

const sharedMenuRuntime = {
  openMenus,
  openMenu,
  openSubmenu,
  closeMenu,
  closeAllMenus
};

export function useMenuRuntime() {
  return sharedMenuRuntime;
}
