import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";

export type UiThemeMode = "system" | "light" | "dark";

const DEFAULT_WINDOW_WIDTH = 1024;

export const useUiStore = defineStore("ui", () => {
  const systemDark = ref(false);
  const themeMode = ref<UiThemeMode>("system");
  const windowWidth = ref(DEFAULT_WINDOW_WIDTH);
  const dark = computed(() => (
    themeMode.value === "system" ? systemDark.value : themeMode.value === "dark"
  ));

  function setWindowWidth(next: number) {
    const nextWidth = Math.round(next);
    if (nextWidth !== windowWidth.value) {
      windowWidth.value = nextWidth;
    }
  }

  function setSystemDark(next: boolean) {
    systemDark.value = next;
  }

  function setThemeMode(next: UiThemeMode) {
    themeMode.value = next;
  }

  const isMobile = computed(() => windowWidth.value < 768);
  const isTablet = computed(() => windowWidth.value >= 768 && windowWidth.value < 1024);
  const isDesktop = computed(() => windowWidth.value >= 1024);

  return {
    dark,
    isDesktop,
    isMobile,
    isTablet,
    setSystemDark,
    setThemeMode,
    setWindowWidth,
    themeMode,
    windowWidth
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUiStore, import.meta.hot));
}
