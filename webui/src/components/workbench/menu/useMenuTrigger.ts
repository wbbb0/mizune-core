import type { MenuNode, MenuSource } from "./types.js";
import { useMenuRuntime } from "./useMenuRuntime.js";

const LONG_PRESS_MS = 420;

export function useMenuTrigger(options: {
  baseId: string;
  source: MenuSource;
  resolveItems: () => MenuNode[];
}) {
  const { openMenu } = useMenuRuntime();
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  function clearLongPress() {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function openFromAnchor(anchor: { x: number; y: number } | { element: HTMLElement | null }) {
    openMenu({
      id: options.baseId,
      source: options.source,
      anchor,
      items: options.resolveItems()
    });
  }

  function onClick(event: MouseEvent) {
    openFromAnchor({ element: event.currentTarget as HTMLElement | null });
  }

  function onContextMenu(event: MouseEvent) {
    event.preventDefault();
    clearLongPress();
    openFromAnchor({ x: event.clientX, y: event.clientY });
  }

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType === "mouse") {
      return;
    }

    clearLongPress();
    longPressTimer = setTimeout(() => {
      openFromAnchor({ x: event.clientX, y: event.clientY });
      longPressTimer = null;
    }, LONG_PRESS_MS);
  }

  function onPointerUp() {
    clearLongPress();
  }

  function onPointerCancel() {
    clearLongPress();
  }

  return {
    onClick,
    onContextMenu,
    onPointerDown,
    onPointerUp,
    onPointerCancel
  };
}
