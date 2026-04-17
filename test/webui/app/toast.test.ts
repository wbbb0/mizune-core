import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { useToastStore } from "../../../webui/src/stores/toasts.ts";

async function runCase(name: string, fn: () => Promise<void> | void) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

function resetStore() {
  const store = useToastStore();
  for (const item of [...store.items.value]) {
    store.dismiss(item.id);
  }
  return store;
}

async function main() {
  await runCase("app mounts a global toast viewport", async () => {
    const source = await readFile(new URL("../../../webui/src/App.vue", import.meta.url), "utf8");

    assert.match(source, /ToastViewport/);
    assert.match(source, /<ToastViewport\s*\/>/);
  });

  await runCase("toast store supports manual dismiss and duplicate message reuse", () => {
    const store = resetStore();
    const firstId = store.push({
      type: "error",
      message: "上传失败",
      durationMs: 500
    });
    const secondId = store.push({
      type: "error",
      message: "上传失败",
      durationMs: 500
    });

    assert.equal(firstId, secondId);
    assert.equal(store.items.value.length, 1);

    store.dismiss(firstId);
    assert.equal(store.items.value.length, 0);
  });

  await runCase("toast store auto dismisses after the configured duration", async () => {
    const store = resetStore();
    store.push({
      type: "success",
      message: "保存成功",
      durationMs: 20
    });

    assert.equal(store.items.value.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(store.items.value.length, 0);
  });

  await runCase("session chat surfaces action failures through toast instead of window.alert", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/ChatPanel.vue", import.meta.url), "utf8");

    assert.doesNotMatch(source, /window\.alert/);
    assert.match(source, /useToastStore/);
  });

  await runCase("composer surfaces upload failures through toast", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/Composer.vue", import.meta.url), "utf8");

    assert.match(source, /useToastStore/);
    assert.match(source, /toast\.push/);
  });

  await runCase("config and data pages use toast instead of inline save containers", async () => {
    const [configSource, dataSource] = await Promise.all([
      readFile(new URL("../../../webui/src/pages/ConfigPage.vue", import.meta.url), "utf8"),
      readFile(new URL("../../../webui/src/pages/DataPage.vue", import.meta.url), "utf8")
    ]);

    assert.match(configSource, /useToastStore/);
    assert.match(dataSource, /useToastStore/);
    assert.doesNotMatch(configSource, /saveMsg/);
    assert.doesNotMatch(dataSource, /saveMsg/);
  });
}

void main();
