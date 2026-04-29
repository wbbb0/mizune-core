import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { activateWorkbenchController, createWorkbenchController } from "../../../webui/src/components/workbench/runtime/workbenchController.ts";
import { defineWorkbenchView } from "../../../webui/src/components/workbench/types.ts";
import { useWorkbenchToasts } from "../../../webui/src/components/workbench/toasts/useWorkbenchToasts.ts";

const { computed, defineComponent } = await import(
  new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href
);

const EmptyArea = defineComponent({
  name: "EmptyArea",
  setup: () => () => null
});
const testController = createWorkbenchController(computed(() => defineWorkbenchView({
  id: "toast-test",
  title: "Toast Test",
  areas: {
    mainArea: EmptyArea
  }
})));
const deactivateTestController = activateWorkbenchController(testController);

function resetStore() {
  const store = useWorkbenchToasts();
  for (const item of [...store.items.value]) {
    store.dismiss(item.id);
  }
  return store;
}

test.after(() => {
  deactivateTestController();
});

test("workbench root mounts the toast viewport", async () => {
  const source = await readFile(new URL("../../../webui/src/components/workbench/WorkbenchRoot.vue", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../../../webui/src/App.vue", import.meta.url), "utf8");

  assert.match(source, /ToastViewport/);
  assert.match(source, /<ToastViewport\s*\/>/);
  assert.doesNotMatch(shellSource, /ToastViewport/);
  assert.doesNotMatch(appSource, /ToastViewport/);
});

test("toast store supports manual dismiss, duplicate reuse, and auto dismiss", async () => {
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
  assert.match(source, /useWorkbenchToasts/);
});

test("composer surfaces upload failures through toast", async () => {
  const source = await readFile(new URL("../../../webui/src/components/sessions/Composer.vue", import.meta.url), "utf8");

  assert.match(source, /useWorkbenchToasts/);
  assert.match(source, /toast\.push/);
  assert.match(source, /只能上传图片文件/);
  assert.match(source, /filterComposerImageFiles/);
  assert.match(source, /function canAcceptFiles\(\)/);
  assert.match(source, /filesFromDataTransfer\(event\.dataTransfer\)/);
  assert.match(source, /filesFromClipboardData\(event\.clipboardData\)/);
  assert.match(source, /files\.length === 0 \|\| !canAcceptFiles\(\)/);
  assert.match(source, /@paste="onPaste"/);
});

test("config and data sections use toast instead of inline save containers", async () => {
  const [configSource, dataSource] = await Promise.all([
    readFile(new URL("../../../webui/src/composables/sections/useConfigSection.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../webui/src/composables/sections/useDataSection.ts", import.meta.url), "utf8")
  ]);

  assert.match(configSource, /useWorkbenchToasts/);
  assert.match(dataSource, /useWorkbenchToasts/);
  assert.doesNotMatch(configSource, /saveMsg/);
  assert.doesNotMatch(dataSource, /saveMsg/);
});
