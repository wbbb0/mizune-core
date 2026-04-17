import assert from "node:assert/strict";
import { useToastStore } from "../../webui/src/stores/toasts.ts";

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
}

void main();
