import test from "node:test";
import assert from "node:assert/strict";
import { activateWorkbenchController, createWorkbenchController } from "../../../webui/src/components/workbench/runtime/workbenchController.ts";
import { defineWorkbenchView } from "../../../webui/src/components/workbench/types.ts";
import { useWorkbenchToasts } from "../../../webui/src/components/workbench/toasts/useWorkbenchToasts.ts";
import { useWorkbenchWindows } from "../../../webui/src/components/workbench/windows/useWorkbenchWindows.ts";

const { computed, defineComponent } = await import(
  new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href
);

const EmptyArea = defineComponent({
  name: "EmptyArea",
  setup: () => () => null
});

function createView(id: string) {
  return defineWorkbenchView({
    id,
    title: id,
    areas: {
      mainArea: EmptyArea
    }
  });
}

test("detached workbench services follow the active controller instead of caching a stale window manager", () => {
  const windows = useWorkbenchWindows();
  const toasts = useWorkbenchToasts();
  const firstController = createWorkbenchController(computed(() => createView("first")));
  const deactivateFirst = activateWorkbenchController(firstController);

  try {
    windows.openDialogSync({
      id: "first-window",
      kind: "dialog",
      title: "first",
      size: "sm"
    });
    const firstToastId = toasts.push({ type: "info", message: "first", durationMs: 1000 });

    assert.ok(firstController.windows.get("first-window"));
    assert.equal(firstController.toasts.items.value.length, 1);

    const secondController = createWorkbenchController(computed(() => createView("second")));
    const deactivateSecond = activateWorkbenchController(secondController);

    try {
      windows.openDialogSync({
        id: "second-window",
        kind: "dialog",
        title: "second",
        size: "sm"
      });
      const secondToastId = toasts.push({ type: "success", message: "second", durationMs: 1000 });

      assert.equal(firstController.windows.get("second-window"), undefined);
      assert.ok(secondController.windows.get("second-window"));
      assert.equal(windows.get("second-window")?.id, "second-window");
      assert.deepEqual(
        windows.desktopWindows.value.map((window) => window.id),
        ["second-window"]
      );
      assert.equal(secondController.toasts.items.value.length, 1);
      assert.equal(toasts.items.value[0]?.message, "second");
      toasts.dismiss(secondToastId);
    } finally {
      deactivateSecond();
    }

    windows.openDialogSync({
      id: "restored-window",
      kind: "dialog",
      title: "restored",
      size: "sm"
    });

    assert.ok(firstController.windows.get("restored-window"));
    assert.equal(windows.get("restored-window")?.id, "restored-window");
    toasts.dismiss(firstToastId);
  } finally {
    deactivateFirst();
  }
});
