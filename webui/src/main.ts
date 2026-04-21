import { createApp } from "vue";
import { createPinia } from "pinia";
import { registerSW } from "virtual:pwa-register";
import App from "./App.vue";
import router from "./router";
import { useUiBrowserBindings } from "@/composables/useUiBrowserBindings";
import { useUiStore } from "@/stores/ui";
import "./style/main.css";

registerSW({ immediate: true });

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
