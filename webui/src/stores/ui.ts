import { defineStore } from "pinia";
import { computed, ref } from "vue";

const LIGHT_THEME_COLOR = "#f5f5f5";
const DARK_THEME_COLOR = "#0b1220";

export const useUiStore = defineStore("ui", () => {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  const dark = ref<boolean>(prefersDark.matches);
  const windowWidth = ref(window.innerWidth);

  function syncViewportWidth() {
    const nextWidth = Math.round(window.visualViewport?.width ?? window.innerWidth);
    if (nextWidth !== windowWidth.value) {
      windowWidth.value = nextWidth;
    }
  }

  function applyTheme() {
    document.documentElement.dataset.theme = dark.value ? "dark" : "light";
    document.documentElement.style.colorScheme = dark.value ? "dark" : "light";

    const themeColor = dark.value ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((meta) => {
        meta.content = themeColor;
      });
  }

  function onSystemThemeChange(event: MediaQueryListEvent) {
    dark.value = event.matches;
    applyTheme();
  }

  window.addEventListener("resize", syncViewportWidth, { passive: true });
  window.visualViewport?.addEventListener("resize", syncViewportWidth, { passive: true });
  prefersDark.addEventListener("change", onSystemThemeChange);

  syncViewportWidth();
  applyTheme();

  const isMobile = computed(() => windowWidth.value < 768);
  const isTablet = computed(() => windowWidth.value >= 768 && windowWidth.value < 1024);
  const isDesktop = computed(() => windowWidth.value >= 1024);

  return { dark, isDesktop, isMobile, isTablet, windowWidth };
});
