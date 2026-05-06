import { ref, type Ref } from "vue";
import type { MenuStackEntry } from "./types.js";

export const SUBMENU_HOVER_DELAY_MS = 240;
export const SUBMENU_ACTIVATION_DELAY_MS = 80;

export type WorkbenchMenuRuntime = {
  openMenus: Ref<MenuStackEntry[]>;
  openMenu: (entry: MenuStackEntry) => void;
  openSubmenu: (entry: MenuStackEntry) => void;
  scheduleSubmenu: (entry: MenuStackEntry, delayMs?: number) => void;
  clearPendingSubmenu: () => void;
  closeMenu: (id: string) => void;
  closeAllMenus: () => void;
};

export function createMenuRuntime(): WorkbenchMenuRuntime {
  const openMenus = ref<MenuStackEntry[]>([]);
  let pendingSubmenuTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSubmenuId: string | null = null;

  function clearPendingSubmenu() {
    if (pendingSubmenuTimer !== null) {
      clearTimeout(pendingSubmenuTimer);
      pendingSubmenuTimer = null;
    }
    pendingSubmenuId = null;
  }

  function openMenu(entry: MenuStackEntry) {
    clearPendingSubmenu();
    openMenus.value = [entry];
  }

  function openSubmenu(entry: MenuStackEntry) {
    clearPendingSubmenu();
    const parentIndex = entry.parentId ? openMenus.value.findIndex((menu) => menu.id === entry.parentId) : -1;
    if (parentIndex < 0) {
      openMenus.value = [...openMenus.value.filter((menu) => menu.id !== entry.id), entry];
      return;
    }

    openMenus.value = [...openMenus.value.slice(0, parentIndex + 1), entry];
  }

  function scheduleSubmenu(entry: MenuStackEntry, delayMs = SUBMENU_HOVER_DELAY_MS) {
    if (openMenus.value.at(-1)?.id === entry.id || pendingSubmenuId === entry.id) {
      return;
    }

    clearPendingSubmenu();
    pendingSubmenuId = entry.id;
    pendingSubmenuTimer = setTimeout(() => {
      pendingSubmenuTimer = null;
      pendingSubmenuId = null;
      openSubmenu(entry);
    }, delayMs);
  }

  function closeMenu(id: string) {
    clearPendingSubmenu();
    const closeIndex = openMenus.value.findIndex((menu) => menu.id === id);
    if (closeIndex < 0) {
      return;
    }

    openMenus.value = openMenus.value.slice(0, closeIndex);
  }

  function closeAllMenus() {
    clearPendingSubmenu();
    openMenus.value = [];
  }

  return {
    openMenus,
    openMenu,
    openSubmenu,
    scheduleSubmenu,
    clearPendingSubmenu,
    closeMenu,
    closeAllMenus
  };
}
