import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("webui dev mode unregisters production service workers instead of keeping PWA cache", async () => {
  const [mainSource, viteConfigSource] = await Promise.all([
    readFile(new URL("../../../webui/src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../webui/vite.config.ts", import.meta.url), "utf8")
  ]);

  assert.match(mainSource, /if \(import\.meta\.env\.PROD\) \{\s+registerSW\(\{ immediate: true \}\);/s);
  assert.match(mainSource, /cleanupDevelopmentServiceWorkers/);
  assert.match(mainSource, /registration\.unregister\(\)/);
  assert.match(mainSource, /caches\.delete\(key\)/);

  assert.match(viteConfigSource, /createDevServiceWorkerCleanupPlugin/);
  assert.match(viteConfigSource, /server\.middlewares\.use\(`\$\{webuiBase\}sw\.js`/);
  assert.match(viteConfigSource, /await self\.registration\.unregister\(\);/);
  assert.match(viteConfigSource, /client\.navigate\(client\.url\);/);
  assert.match(viteConfigSource, /devOptions:\s*\{\s+enabled: false,/s);
});
