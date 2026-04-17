import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("app mounts a global toast viewport", async () => {
    const source = await readFile(new URL("../../webui/src/App.vue", import.meta.url), "utf8");

    assert.match(source, /ToastViewport/);
    assert.match(source, /<ToastViewport\s*\/>/);
  });

  await runCase("session chat surfaces action failures through toast instead of window.alert", async () => {
    const source = await readFile(new URL("../../webui/src/components/sessions/ChatPanel.vue", import.meta.url), "utf8");

    assert.doesNotMatch(source, /window\.alert/);
    assert.match(source, /useToastStore/);
  });

  await runCase("composer surfaces upload failures through toast", async () => {
    const source = await readFile(new URL("../../webui/src/components/sessions/Composer.vue", import.meta.url), "utf8");

    assert.match(source, /useToastStore/);
    assert.match(source, /toast\.push/);
  });

  await runCase("config and data pages use toast instead of inline save containers", async () => {
    const [configSource, dataSource] = await Promise.all([
      readFile(new URL("../../webui/src/pages/ConfigPage.vue", import.meta.url), "utf8"),
      readFile(new URL("../../webui/src/pages/DataPage.vue", import.meta.url), "utf8")
    ]);

    assert.match(configSource, /useToastStore/);
    assert.match(dataSource, /useToastStore/);
    assert.doesNotMatch(configSource, /saveMsg/);
    assert.doesNotMatch(dataSource, /saveMsg/);
  });
}

void main();
