import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("section host resolves section ids and delegates rendering to workbench shell", async () => {
  const source = await readFile(
    new URL("../../../webui/src/components/workbench/SectionHost.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /defineProps<\{\s*sectionId: string;\s*\}>/);
  assert.match(source, /useWorkbenchRegistry/);
  assert.match(source, /<WorkbenchShell :section="section"/);
});

test("workbench shell owns navigation and mobile list-main switching", async () => {
  const source = await readFile(
    new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /ActivityBar/);
  assert.match(source, /useWorkbenchRuntime/);
  assert.match(source, /showList/);
  assert.match(source, /showMain/);
  assert.match(source, /watch\(/);
  assert.match(source, /section\.layout\.mobileMainFlow/);
  assert.match(source, /section\.regions\.listPane/);
  assert.match(source, /section\.regions\.mainPane/);
  assert.match(source, /section\.regions\.mobileHeader/);
});

test("workbench shell renders the shared mobile top bar on the list screen", async () => {
  const source = await readFile(
    new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /useRoute/);
  assert.match(source, /workbenchNavItems/);
  assert.match(source, /routeLabel/);
  assert.match(source, /v-show="mobileScreen === 'list'"/);
  assert.match(source, /<header class="pt-safe flex h-\[calc\(44px\+env\(safe-area-inset-top\)\)\]/);
  assert.match(source, /<nav class="flex gap-1">/);
  assert.match(source, /transition-transform duration-220 ease-\[ease\]/);
  assert.match(source, /<svg width="20" height="20" viewBox="0 0 24 24"/);
  assert.match(source, /<polyline points="15 18 9 12 15 6"/);
});
