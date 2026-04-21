import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("desktop layout keeps safe-area padding on the workbench shell, not the activity bar", async () => {
  const workbenchShellSource = await readFile(
    new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url),
    "utf8"
  );
  const topBarSource = await readFile(
    new URL("../../../webui/src/components/workbench/TopBar.vue", import.meta.url),
    "utf8"
  );
  const activityBarSource = await readFile(
    new URL("../../../webui/src/components/layout/ActivityBar.vue", import.meta.url),
    "utf8"
  );
  const composerSource = await readFile(
    new URL("../../../webui/src/components/sessions/Composer.vue", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(workbenchShellSource, /pt-safe/);
  assert.match(topBarSource, /pt-safe/);
  assert.match(activityBarSource, /from "@\/components\/workbench\/navigation"/);
  assert.doesNotMatch(activityBarSource, /export const primaryNavItems/);
  assert.doesNotMatch(activityBarSource, /export const bottomNavItems/);
  assert.doesNotMatch(activityBarSource, /class="[^"]*\bpt-safe\b/);
  assert.doesNotMatch(activityBarSource, /class="[^"]*\bpb-safe\b/);
  assert.match(composerSource, /ui\.isDesktop \|\| keyboardInsetPx\.value > 0/);
});
