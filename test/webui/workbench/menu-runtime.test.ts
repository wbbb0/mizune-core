import test from "node:test";
import assert from "node:assert/strict";
import {
  createMenuRuntime,
  SUBMENU_ACTIVATION_DELAY_MS,
  SUBMENU_HOVER_DELAY_MS
} from "../../../webui/src/components/workbench/menu/menuRuntime.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let runtime = createMenuRuntime();

test.beforeEach(() => {
  runtime = createMenuRuntime();
});

test.afterEach(() => {
  runtime.closeAllMenus();
});

test("submenu hover opens after a short cancellable delay", async () => {
  runtime.openMenu({
    id: "root",
    source: "topbar",
    anchor: { x: 0, y: 0 },
    items: []
  });

  runtime.scheduleSubmenu({
    id: "root:child",
    parentId: "root",
    source: "topbar",
    anchor: { element: null },
    items: []
  });

  assert.deepEqual(runtime.openMenus.value.map((menu) => menu.id), ["root"]);
  await wait(SUBMENU_HOVER_DELAY_MS + 20);
  assert.deepEqual(runtime.openMenus.value.map((menu) => menu.id), ["root", "root:child"]);
});

test("submenu delay can be cancelled before it opens", async () => {
  runtime.openMenu({
    id: "root",
    source: "topbar",
    anchor: { x: 0, y: 0 },
    items: []
  });

  runtime.scheduleSubmenu({
    id: "root:child",
    parentId: "root",
    source: "topbar",
    anchor: { element: null },
    items: []
  });
  runtime.clearPendingSubmenu();

  await wait(SUBMENU_HOVER_DELAY_MS + 20);
  assert.deepEqual(runtime.openMenus.value.map((menu) => menu.id), ["root"]);
});

test("submenu click uses a shorter delayed activation to avoid same-tap submenu selection", async () => {
  runtime.openMenu({
    id: "root",
    source: "mobile-workbench",
    anchor: { x: 0, y: 0 },
    items: []
  });

  runtime.scheduleSubmenu({
    id: "root:child",
    parentId: "root",
    source: "mobile-workbench",
    anchor: { element: null },
    items: []
  }, SUBMENU_ACTIVATION_DELAY_MS);

  assert.deepEqual(runtime.openMenus.value.map((menu) => menu.id), ["root"]);
  await wait(SUBMENU_ACTIVATION_DELAY_MS + 20);
  assert.deepEqual(runtime.openMenus.value.map((menu) => menu.id), ["root", "root:child"]);
});
