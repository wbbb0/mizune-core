import { readonly, ref } from "vue";
import { registerSW } from "virtual:pwa-register";
import { activateWaitingServiceWorker } from "@/pwa/activateWaitingServiceWorker";

const updateAvailable = ref(false);
const updating = ref(false);
const updateError = ref<string | null>(null);
let serviceWorkerRegistration: ServiceWorkerRegistration | null = null;

export function registerPwaUpdate(): void {
  registerSW({
    immediate: true,
    onNeedRefresh() {
      updateError.value = null;
      updateAvailable.value = true;
    },
    onRegisteredSW(_serviceWorkerUrl, registration) {
      serviceWorkerRegistration = registration ?? null;
    },
    onRegisterError(error) {
      console.error("注册 WebUI Service Worker 失败", error);
    }
  });
}

export function usePwaUpdate() {
  async function applyUpdate(): Promise<void> {
    if (updating.value || !("serviceWorker" in navigator)) {
      return;
    }
    updating.value = true;
    updateError.value = null;
    try {
      const registration = serviceWorkerRegistration
        ?? await navigator.serviceWorker.getRegistration(new URL(import.meta.env.BASE_URL, window.location.origin).href);
      if (!registration) {
        throw new Error("找不到 WebUI Service Worker 注册信息，请重新加载页面");
      }
      serviceWorkerRegistration = registration;
      await activateWaitingServiceWorker(registration, navigator.serviceWorker);
    } catch (error) {
      updating.value = false;
      updateError.value = error instanceof Error ? error.message : "激活 WebUI 更新失败，请重试";
      console.error("激活 WebUI 更新失败", error);
    }
  }

  function dismissUpdate(): void {
    if (updating.value) {
      return;
    }
    updateAvailable.value = false;
    updateError.value = null;
  }

  return {
    updateAvailable: readonly(updateAvailable),
    updating: readonly(updating),
    updateError: readonly(updateError),
    applyUpdate,
    dismissUpdate
  };
}
