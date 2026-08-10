import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("webui prompts before activating production updates and cleans production caches in dev", async () => {
  const [mainSource, viteConfigSource, updateSource, promptSource, serviceWorkerSource, appSource] = await Promise.all([
    readFile(new URL("../../../webui/src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../webui/vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../webui/src/composables/usePwaUpdate.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../webui/src/components/app/PwaUpdatePrompt.vue", import.meta.url), "utf8"),
    readFile(new URL("../../../webui/src/sw.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../webui/src/App.vue", import.meta.url), "utf8")
  ]);

  assert.match(mainSource, /if \(import\.meta\.env\.PROD\) \{\s+registerPwaUpdate\(\);/s);
  assert.match(mainSource, /cleanupDevelopmentServiceWorkers/);
  assert.match(mainSource, /registration\.unregister\(\)/);
  assert.match(mainSource, /caches\.delete\(key\)/);

  assert.match(updateSource, /registerSW\(\{/);
  assert.match(updateSource, /onNeedRefresh\(\)/);
  assert.match(updateSource, /updateAvailable\.value = true/);
  assert.match(updateSource, /await updateServiceWorker\(\)/);
  assert.match(updateSource, /dismissUpdate/);
  assert.match(promptSource, /WebUI 新版本已就绪/);
  assert.match(promptSource, /当前页面不会自动中断/);
  assert.match(promptSource, /@click="applyUpdate"/);
  assert.match(promptSource, /@click="dismissUpdate"/);
  assert.match(appSource, /<PwaUpdatePrompt \/>/);

  assert.doesNotMatch(serviceWorkerSource, /^self\.skipWaiting\(\);$/m);
  assert.match(serviceWorkerSource, /event\.data\?\.type === "SKIP_WAITING"/);
  assert.match(serviceWorkerSource, /void self\.skipWaiting\(\)/);
  assert.match(serviceWorkerSource, /clientsClaim\(\)/);

  assert.match(viteConfigSource, /registerType:\s*"prompt"/);
  assert.match(viteConfigSource, /createDevServiceWorkerCleanupPlugin/);
  assert.match(viteConfigSource, /server\.middlewares\.use\(`\$\{webuiBase\}sw\.js`/);
  assert.match(viteConfigSource, /await self\.registration\.unregister\(\);/);
  assert.match(viteConfigSource, /client\.navigate\(client\.url\);/);
  assert.match(viteConfigSource, /devOptions:\s*\{\s+enabled: false,/s);
});
