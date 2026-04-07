import { computed, onMounted, onUnmounted, ref } from "vue";

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLTextAreaElement) {
    return !target.readOnly && !target.disabled;
  }
  if (target instanceof HTMLInputElement) {
    const textLikeTypes = new Set([
      "text",
      "search",
      "email",
      "url",
      "tel",
      "number",
      "password"
    ]);
    return !target.readOnly && !target.disabled && textLikeTypes.has(target.type);
  }
  return target.isContentEditable;
}

export function useVisualViewportInset() {
  const keyboardInsetPx = ref(0);
  const editableFocused = ref(false);
  const viewportHeightPx = ref(typeof window !== "undefined" ? Math.round(window.visualViewport?.height ?? window.innerHeight) : 0);
  let virtualKeyboard: (Navigator & {
    virtualKeyboard?: {
      addEventListener?: (type: "geometrychange", listener: () => void) => void;
      removeEventListener?: (type: "geometrychange", listener: () => void) => void;
    };
  })["virtualKeyboard"];

  const update = () => {
    if (typeof window !== "undefined") {
      viewportHeightPx.value = Math.round(window.visualViewport?.height ?? window.innerHeight);
    }

    const activeElement = typeof document !== "undefined" ? document.activeElement : null;
    editableFocused.value = isEditableElement(activeElement);

    if (typeof window === "undefined" || !window.visualViewport || !editableFocused.value) {
      keyboardInsetPx.value = 0;
      return;
    }

    const viewport = window.visualViewport;
    const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    keyboardInsetPx.value = inset > 0 ? inset : 0;
  };

  onMounted(() => {
    update();

    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("focusin", update);
    window.addEventListener("focusout", update);
    window.addEventListener("orientationchange", update);

    virtualKeyboard = (navigator as Navigator & {
      virtualKeyboard?: {
        addEventListener?: (type: "geometrychange", listener: () => void) => void;
        removeEventListener?: (type: "geometrychange", listener: () => void) => void;
      };
    }).virtualKeyboard;
    virtualKeyboard?.addEventListener?.("geometrychange", update);

  });

  onUnmounted(() => {
    const viewport = typeof window !== "undefined" ? window.visualViewport : null;
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
    window.removeEventListener("focusin", update);
    window.removeEventListener("focusout", update);
    window.removeEventListener("orientationchange", update);
    virtualKeyboard?.removeEventListener?.("geometrychange", update);
  });

  return {
    keyboardInsetPx,
    keyboardInsetStylePx: computed(() => `${keyboardInsetPx.value}px`),
    viewportHeightPx,
    viewportHeightStylePx: computed(() => `${viewportHeightPx.value}px`)
  };
}
