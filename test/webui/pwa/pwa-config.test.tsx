import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("vite pwa autoUpdate explicitly enables immediate service worker activation", async () => {
    const source = await readFile(new URL("../../../webui/vite.config.ts", import.meta.url), "utf8");

    assert.match(source, /workbox:\s*{[\s\S]*skipWaiting:\s*true/);
    assert.match(source, /workbox:\s*{[\s\S]*clientsClaim:\s*true/);
  });
}

void main();
