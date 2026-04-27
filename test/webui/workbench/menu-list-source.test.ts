import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("menu list schedules submenu opening instead of opening synchronously", async () => {
  const source = await readFile(
    new URL("../../../webui/src/components/workbench/menu/MenuList.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /scheduleSubmenu/);
  assert.match(source, /SUBMENU_ACTIVATION_DELAY_MS/);
  assert.match(source, /@mouseenter="onHover\(item, \$event\)"/);
  assert.match(source, /@mouseleave="onLeave\(item\)"/);
  assert.doesNotMatch(source, /openSubmenu\(\{/);
});
