import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("vite pwa autoUpdate enables production activation and dev cache cleanup", async () => {
  const source = await readFile(new URL("../../../webui/vite.config.ts", import.meta.url), "utf8");

  assert.match(source, /workbox:\s*{[\s\S]*skipWaiting:\s*true/);
  assert.match(source, /workbox:\s*{[\s\S]*clientsClaim:\s*true/);
  assert.match(source, /createDevServiceWorkerCleanupPlugin/);
  assert.match(source, /server\.middlewares\.use\(`\$\{webuiBase\}sw\.js`/);
  assert.match(source, /await self\.registration\.unregister\(\);/);
  assert.match(source, /client\.navigate\(client\.url\);/);
  assert.match(source, /devOptions:\s*{[\s\S]*enabled:\s*false/);
  assert.match(source, /devOptions:\s*{[\s\S]*suppressWarnings:\s*true/);
});
