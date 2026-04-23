import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("vite pwa autoUpdate explicitly enables immediate service worker activation", async () => {
  const source = await readFile(new URL("../../../webui/vite.config.ts", import.meta.url), "utf8");

  assert.match(source, /workbox:\s*{[\s\S]*skipWaiting:\s*true/);
  assert.match(source, /workbox:\s*{[\s\S]*clientsClaim:\s*true/);
  assert.match(source, /devOptions:\s*{[\s\S]*enabled:\s*true/);
  assert.match(source, /devOptions:\s*{[\s\S]*suppressWarnings:\s*true/);
});
