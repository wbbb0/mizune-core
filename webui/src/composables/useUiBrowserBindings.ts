import { watch } from "vue";
import type { useUiStore } from "@/stores/ui";

const LIGHT_THEME_COLOR = "#f5f5f5";
const DARK_THEME_COLOR = "#0b1220";

let teardownUiBrowserBindings: (() => void) | null = null;

function syncViewportWidth(ui: ReturnType<typeof useUiStore>) {
  ui.setWindowWidth(Math.round(window.visualViewport?.width ?? window.innerWidth));
}

function applyTheme(dark: boolean) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";

  const themeColor = dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => {
      meta.content = themeColor;
    });
}

export function useUiBrowserBindings(ui: ReturnType<typeof useUiStore>) {
  teardownUiBrowserBindings?.();

  if (typeof window === "undefined") {
    teardownUiBrowserBindings = null;
    return () => {};
  }

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  const onResize = () => syncViewportWidth(ui);
  const onSystemThemeChange = () => {
    ui.setSystemDark(prefersDark.matches);
  };
  const stopThemeWatcher = watch(
    () => ui.dark,
    (dark) => applyTheme(dark),
    { immediate: true }
  );

  onSystemThemeChange();
  onResize();

  window.addEventListener("resize", onResize, { passive: true });
  window.visualViewport?.addEventListener("resize", onResize, { passive: true });
  prefersDark.addEventListener("change", onSystemThemeChange);

  teardownUiBrowserBindings = () => {
    stopThemeWatcher();
    window.removeEventListener("resize", onResize);
    window.visualViewport?.removeEventListener("resize", onResize);
    prefersDark.removeEventListener("change", onSystemThemeChange);
  };

  return () => {
    teardownUiBrowserBindings?.();
    teardownUiBrowserBindings = null;
  };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    teardownUiBrowserBindings?.();
    teardownUiBrowserBindings = null;
  });
}
