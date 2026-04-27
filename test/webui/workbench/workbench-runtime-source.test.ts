import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("workbench shell creates, provides, and activates a runtime", async () => {
  const shell = await readFile(new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");

  assert.match(runtime, /export function createWorkbenchRuntime/);
  assert.match(runtime, /export function provideWorkbenchRuntime/);
  assert.match(runtime, /export function useWorkbenchRuntimeContext/);
  assert.match(runtime, /export function activateWorkbenchRuntime/);
  assert.match(shell, /createWorkbenchRuntime/);
  assert.match(shell, /provideWorkbenchRuntime/);
  assert.match(shell, /activateWorkbenchRuntime/);
  assert.match(shell, /onUnmounted/);
});

test("mobile workbench keeps list mounted under the main overlay", async () => {
  const source = await readFile(new URL("../../../webui/src/components/workbench/MobileWorkbench.vue", import.meta.url), "utf8");
  const types = await readFile(new URL("../../../webui/src/components/workbench/types.ts", import.meta.url), "utf8");
  const sessionsSection = await readFile(new URL("../../../webui/src/sections/sessions/index.ts", import.meta.url), "utf8");

  assert.match(source, /isMobileMainVisible/);
  assert.match(source, /popMobileRegion/);
  assert.match(source, /layout\.mobile\.mainFlow/);
  assert.doesNotMatch(source, /mobileMainFlow/);
  assert.match(types, /mobile:\s*\{/);
  assert.match(types, /mainFlow:/);
  assert.match(sessionsSection, /defineWorkbenchSection/);
  assert.doesNotMatch(sessionsSection, /mainFlow:\s*"list-main"/);
  assert.doesNotMatch(source, /v-show="mobileScreen === 'list'"/);
});

test("mobile workbench maps browser history back to overlay stack pop", async () => {
  const source = await readFile(new URL("../../../webui/src/components/workbench/MobileWorkbench.vue", import.meta.url), "utf8");

  assert.match(source, /window\.history\.pushState/);
  assert.match(source, /window\.history\.back\(\)/);
  assert.match(source, /addEventListener\("popstate"/);
  assert.match(source, /removeEventListener\("popstate"/);
  assert.match(source, /props\.runtime\.popMobileRegion\(\)/);
});

test("workbench navigation commands live in the runtime module", async () => {
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");
  const configSection = await readFile(new URL("../../../webui/src/composables/sections/useConfigSection.ts", import.meta.url), "utf8");

  assert.match(runtime, /export function useWorkbenchNavigation/);
  assert.match(runtime, /activeWorkbenchRuntime\.value/);
  assert.match(runtime, /runtime\.showMain\(detailKey\)/);
  assert.match(runtime, /runtime\.showList\(\)/);
  assert.match(configSection, /useWorkbenchNavigation/);
  await assert.rejects(
    access(new URL("../../../webui/src/composables/workbench/useWorkbenchRuntime.ts", import.meta.url))
  );
});

test("workbench runtime exposes an active shell command facade", async () => {
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");
  const shell = await readFile(new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url), "utf8");

  assert.match(runtime, /export function useActiveWorkbenchRuntime/);
  assert.match(runtime, /useWorkbenchNavigation/);
  assert.match(shell, /const deactivateRuntime = activateWorkbenchRuntime\(runtime\)/);
});

test("desktop workbench sizes list pane through runtime resize state", async () => {
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");
  const desktop = await readFile(new URL("../../../webui/src/components/workbench/DesktopWorkbench.vue", import.meta.url), "utf8");
  const types = await readFile(new URL("../../../webui/src/components/workbench/types.ts", import.meta.url), "utf8");
  const sessionsSection = await readFile(new URL("../../../webui/src/sections/sessions/index.ts", import.meta.url), "utf8");

  assert.match(types, /desktop:\s*\{/);
  assert.match(types, /listPane\?:/);
  assert.doesNotMatch(types, /desktopListPane/);
  assert.match(sessionsSection, /defineWorkbenchSection/);
  assert.doesNotMatch(sessionsSection, /listPane:\s*\{\}/);
  assert.match(runtime, /desktopListPaneWidthPx/);
  assert.match(runtime, /setDesktopListPaneWidth/);
  assert.match(runtime, /clampDesktopListPaneWidth/);
  assert.match(runtime, /layout\.desktop\.listPane/);
  assert.doesNotMatch(runtime, /layout\.desktopListPane/);
  assert.match(desktop, /desktopListPaneStyle/);
  assert.match(desktop, /startListPaneResize/);
  assert.match(desktop, /role="separator"/);
  assert.match(desktop, /aria-orientation="vertical"/);
  assert.match(desktop, /@pointerdown="startListPaneResize"/);
  assert.doesNotMatch(desktop, /w-\(--side-panel-width\)/);
});

test("workbench sections use a definition helper for default layout", async () => {
  const types = await readFile(new URL("../../../webui/src/components/workbench/types.ts", import.meta.url), "utf8");
  const registry = await readFile(new URL("../../../webui/src/sections/registry.ts", import.meta.url), "utf8");
  const sectionSources = await Promise.all(["sessions", "config", "data", "settings", "workspace"].map((name) =>
    readFile(new URL(`../../../webui/src/sections/${name}/index.ts`, import.meta.url), "utf8")
  ));

  assert.match(types, /export function defineWorkbenchSection/);
  assert.match(types, /defaultWorkbenchSectionLayout/);
  assert.match(registry, /defineWorkbenchSection/);
  for (const source of sectionSources) {
    assert.match(source, /defineWorkbenchSection/);
    assert.doesNotMatch(source, /satisfies WorkbenchSection/);
    assert.doesNotMatch(source, /layout:\s*\{\s*mobile:\s*\{/s);
  }
});

test("desktop workbench persists list pane width per section", async () => {
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");

  assert.match(runtime, /readStoredDesktopListPaneWidth/);
  assert.match(runtime, /writeStoredDesktopListPaneWidth/);
  assert.match(runtime, /localStorage/);
  assert.match(runtime, /sectionId/);
  assert.match(runtime, /workbench\.pane\.desktopList/);
  assert.match(runtime, /watch\(\(\)\s*=>\s*section\.value\.id/);
});

test("legacy app layout shell is removed after workbench runtime migration", async () => {
  const theme = await readFile(new URL("../../../webui/src/style/theme.css", import.meta.url), "utf8");

  await assert.rejects(
    access(new URL("../../../webui/src/components/layout/AppLayout.vue", import.meta.url))
  );
  assert.doesNotMatch(theme, /--side-panel-width/);
});
