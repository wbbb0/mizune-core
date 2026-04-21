import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { useToastStore } from "../../../webui/src/stores/toasts.ts";

function resetStore() {
  const store = useToastStore();
  for (const item of [...store.items.value]) {
    store.dismiss(item.id);
  }
  return store;
}

  test("app mounts a global toast viewport", async () => {
    const source = await readFile(new URL("../../../webui/src/App.vue", import.meta.url), "utf8");

    assert.match(source, /ToastViewport/);
    assert.match(source, /<ToastViewport\s*\/>/);
  });

  test("toast store supports manual dismiss and duplicate message reuse", () => {
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

  test("toast store auto dismisses after the configured duration", async () => {
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

  test("session chat surfaces action failures through toast instead of window.alert", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/ChatPanel.vue", import.meta.url), "utf8");

    assert.doesNotMatch(source, /window\.alert/);
    assert.match(source, /useToastStore/);
  });

  test("composer surfaces upload failures through toast", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/Composer.vue", import.meta.url), "utf8");

    assert.match(source, /useToastStore/);
    assert.match(source, /toast\.push/);
  });

  test("config and data sections use toast instead of inline save containers", async () => {
    const [configSource, dataSource] = await Promise.all([
      readFile(new URL("../../../webui/src/composables/sections/useConfigSection.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../webui/src/composables/sections/useDataSection.ts", import.meta.url), "utf8")
    ]);

    assert.match(configSource, /useToastStore/);
    assert.match(dataSource, /useToastStore/);
    assert.doesNotMatch(configSource, /saveMsg/);
    assert.doesNotMatch(dataSource, /saveMsg/);
  });
