import { readonly, ref } from "vue";
import { registerSW } from "virtual:pwa-register";

const updateAvailable = ref(false);
const updating = ref(false);
let updateServiceWorker: (() => Promise<void>) | null = null;

export function registerPwaUpdate(): void {
  updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateAvailable.value = true;
    },
    onRegisterError(error) {
      console.error("注册 WebUI Service Worker 失败", error);
    }
  });
}

export function usePwaUpdate() {
  async function applyUpdate(): Promise<void> {
    if (!updateServiceWorker || updating.value) {
      return;
    }
    updating.value = true;
    try {
      await updateServiceWorker();
    } catch (error) {
      updating.value = false;
      console.error("激活 WebUI 更新失败", error);
    }
  }

  function dismissUpdate(): void {
    updateAvailable.value = false;
  }

  return {
    updateAvailable: readonly(updateAvailable),
    updating: readonly(updating),
    applyUpdate,
    dismissUpdate
  };
}
