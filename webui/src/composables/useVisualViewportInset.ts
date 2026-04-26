import { computed, onMounted, onUnmounted, ref, type Ref } from "vue";

type KeyboardInsetInput = {
  baselineViewportHeight: number;
  viewportHeight: number;
  viewportOffsetTop: number;
  targetBottom?: number | null;
};

type VisualViewportInsetOptions = {
  target?: Readonly<Ref<HTMLElement | null>>;
};

export function resolveKeyboardInsetPx(input: KeyboardInsetInput): number {
  const viewportBottom = input.viewportOffsetTop + input.viewportHeight;
  const boundaryBottom = input.targetBottom ?? input.baselineViewportHeight;
  return Math.max(0, Math.round(boundaryBottom - viewportBottom));
}

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

export function useVisualViewportInset(options: VisualViewportInsetOptions = {}) {
  const keyboardInsetPx = ref(0);
  const editableFocused = ref(false);
  const viewportHeightPx = ref(typeof window !== "undefined" ? Math.round(window.visualViewport?.height ?? window.innerHeight) : 0);
  const baselineViewportHeightPx = ref(viewportHeightPx.value);
  const deferredUpdateTimers: number[] = [];
  let virtualKeyboard: (Navigator & {
    virtualKeyboard?: {
      addEventListener?: (type: "geometrychange", listener: () => void) => void;
      removeEventListener?: (type: "geometrychange", listener: () => void) => void;
    };
  })["virtualKeyboard"];

  const readViewportHeight = () => (
    typeof window !== "undefined"
      ? Math.round(window.visualViewport?.height ?? window.innerHeight)
      : 0
  );

  const update = () => {
    const nextViewportHeight = readViewportHeight();
    viewportHeightPx.value = nextViewportHeight;
    const activeElement = typeof document !== "undefined" ? document.activeElement : null;
    editableFocused.value = isEditableElement(activeElement);

    if (typeof window === "undefined" || !window.visualViewport || !editableFocused.value) {
      keyboardInsetPx.value = 0;
      baselineViewportHeightPx.value = Math.max(baselineViewportHeightPx.value, nextViewportHeight);
      return;
    }

    const viewport = window.visualViewport;
    baselineViewportHeightPx.value = Math.max(baselineViewportHeightPx.value, nextViewportHeight);
    keyboardInsetPx.value = resolveKeyboardInsetPx({
      baselineViewportHeight: baselineViewportHeightPx.value,
      viewportHeight: viewport.height,
      viewportOffsetTop: viewport.offsetTop,
      targetBottom: options.target?.value?.getBoundingClientRect().bottom ?? null
    });
  };

  const clearDeferredUpdates = () => {
    while (deferredUpdateTimers.length > 0) {
      const timerId = deferredUpdateTimers.pop();
      if (timerId != null) {
        window.clearTimeout(timerId);
      }
    }
  };

  const scheduleDeferredUpdates = () => {
    if (typeof window === "undefined") {
      return;
    }
    clearDeferredUpdates();
    for (const delayMs of [0, 32, 96, 180, 320, 520]) {
      deferredUpdateTimers.push(window.setTimeout(update, delayMs));
    }
  };

  const onFocusIn = () => {
    update();
    scheduleDeferredUpdates();
  };

  const onFocusOut = () => {
    clearDeferredUpdates();
    update();
  };

  onMounted(() => {
    update();

    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("focusout", onFocusOut);
    window.addEventListener("orientationchange", resetViewportBaseline);

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
    window.removeEventListener("focusin", onFocusIn);
    window.removeEventListener("focusout", onFocusOut);
    window.removeEventListener("orientationchange", resetViewportBaseline);
    virtualKeyboard?.removeEventListener?.("geometrychange", update);
    clearDeferredUpdates();
  });

  return {
    keyboardInsetPx,
    keyboardInsetStylePx: computed(() => `${keyboardInsetPx.value}px`),
    viewportHeightPx,
    viewportHeightStylePx: computed(() => `${viewportHeightPx.value}px`)
  };

  function resetViewportBaseline() {
    baselineViewportHeightPx.value = readViewportHeight();
    update();
  }
}
