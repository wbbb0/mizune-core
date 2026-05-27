import { createApp } from "vue";
import { createPinia } from "pinia";
import { registerSW } from "virtual:pwa-register";
import App from "./App.vue";
import router from "./router";
import { useUiBrowserBindings } from "@/composables/useUiBrowserBindings";
import { useUiStore } from "@/stores/ui";
import { editorApi } from "@/api/editor";
import { configureResourceEditorClient } from "@workbench-kit/vue";
import "./style/main.css";

async function cleanupDevelopmentServiceWorkers() {
  if (!import.meta.env.DEV || !("serviceWorker" in navigator)) {
    return;
  }

  const scopePrefix = new URL(import.meta.env.BASE_URL, window.location.origin).href;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations
      .filter((registration) => registration.scope.startsWith(scopePrefix))
      .map((registration) => registration.unregister())
  );

  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith("workbox-") || key.includes("precache"))
        .map((key) => caches.delete(key))
    );
  }
}

if (import.meta.env.PROD) {
  registerSW({ immediate: true });
} else {
  void cleanupDevelopmentServiceWorkers();
}

configureResourceEditorClient(editorApi);

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);

const cleanupUiBrowserBindings = useUiBrowserBindings(useUiStore(pinia));

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cleanupUiBrowserBindings();
  });
}

app.mount("#app");
