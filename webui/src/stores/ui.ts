import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";

export type UiThemeMode = "system" | "light" | "dark";

export const useUiStore = defineStore("ui", () => {
  const systemDark = ref(false);
  const themeMode = ref<UiThemeMode>("system");
  const dark = computed(() => (
    themeMode.value === "system" ? systemDark.value : themeMode.value === "dark"
  ));

  function setSystemDark(next: boolean) {
    systemDark.value = next;
  }

  function setThemeMode(next: UiThemeMode) {
    themeMode.value = next;
  }

  return {
    dark,
    setSystemDark,
    setThemeMode,
    themeMode
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUiStore, import.meta.hot));
}
