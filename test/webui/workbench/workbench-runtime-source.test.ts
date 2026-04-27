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

test("workbench core receives navigation from the app adapter", async () => {
  const shell = await readFile(new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url), "utf8");
  const mobile = await readFile(new URL("../../../webui/src/components/workbench/MobileWorkbench.vue", import.meta.url), "utf8");
  const desktop = await readFile(new URL("../../../webui/src/components/workbench/DesktopWorkbench.vue", import.meta.url), "utf8");
  const activityBar = await readFile(new URL("../../../webui/src/components/layout/ActivityBar.vue", import.meta.url), "utf8");
  const sectionHost = await readFile(new URL("../../../webui/src/sections/SectionHost.vue", import.meta.url), "utf8");

  assert.match(shell, /navItems/);
  assert.match(shell, /activeNavItemId/);
  assert.match(desktop, /@navigate="emit\('navigate', \$event\)"/);
  assert.match(mobile, /props\.navItems/);
  assert.doesNotMatch(mobile, /useRoute/);
  assert.doesNotMatch(mobile, /workbenchNavItems/);
  assert.match(activityBar, /navItems/);
  assert.doesNotMatch(activityBar, /useRouter/);
  assert.doesNotMatch(activityBar, /workbenchNavItems/);
  assert.match(sectionHost, /workbenchNavItems/);
  assert.match(sectionHost, /router\.push\(item\.path\)/);
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

test("mobile main-only sections do not synthesize list navigation", async () => {
  const source = await readFile(new URL("../../../webui/src/components/workbench/MobileWorkbench.vue", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");

  assert.match(runtime, /hasMobileListFlow/);
  assert.match(runtime, /canPopMobileRegion/);
  assert.match(runtime, /if \(!hasMobileListFlow\.value\)/);
  assert.match(source, /const hasMobileListFlow/);
  assert.match(source, /v-if="hasMobileListFlow"/);
  assert.match(source, /!visible \|\| !hasMobileListFlow\.value/);
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
  assert.match(runtime, /getDesktopPaneWidthPx/);
  assert.match(runtime, /getDesktopPaneStyle/);
  assert.match(runtime, /setDesktopPaneWidth/);
  assert.match(runtime, /resetDesktopPaneWidth/);
  assert.match(runtime, /clampDesktopPaneWidth/);
  assert.match(runtime, /layout\.desktop\.listPane/);
  assert.doesNotMatch(runtime, /layout\.desktopListPane/);
  assert.match(desktop, /listPaneStyle/);
  assert.match(desktop, /getDesktopPaneStyle\("list"\)/);
  assert.match(desktop, /setDesktopPaneWidth\("list"/);
  assert.match(desktop, /hasListPane/);
  assert.match(desktop, /startListPaneResize/);
  assert.match(desktop, /resetListPaneResize/);
  assert.match(desktop, /role="separator"/);
  assert.match(desktop, /aria-orientation="vertical"/);
  assert.match(desktop, /<aside v-if="hasListPane"/);
  assert.match(desktop, /v-if="hasListPane"\s*\n\s*class="relative w-1/);
  assert.match(desktop, /@pointerdown="startListPaneResize"/);
  assert.match(desktop, /@dblclick="resetListPaneResize"/);
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

test("desktop workbench persists pane widths by global pane id", async () => {
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");

  assert.match(runtime, /readStoredDesktopPaneWidth/);
  assert.match(runtime, /writeStoredDesktopPaneWidth/);
  assert.match(runtime, /localStorage/);
  assert.match(runtime, /workbench\.pane\.desktop/);
  assert.match(runtime, /resolveDesktopPaneStorageKey\(paneId: DesktopPaneId\)/);
  assert.match(runtime, /readStoredDesktopPaneWidth\(paneId: DesktopPaneId\)/);
  assert.match(runtime, /writeStoredDesktopPaneWidth\(paneId: DesktopPaneId, widthPx: number\)/);
  assert.doesNotMatch(runtime, /desktopListPaneWidthPx/);
  assert.doesNotMatch(runtime, /readStoredDesktopPaneWidth\(sectionId/);
  assert.doesNotMatch(runtime, /writeStoredDesktopPaneWidth\(sectionId/);
  assert.doesNotMatch(runtime, /writeStoredDesktopPaneWidth\(section\.value\.id/);
  assert.match(runtime, /watch\(\(\)\s*=>\s*section\.value\.id/);
});

test("legacy app layout shell is removed after workbench runtime migration", async () => {
  const theme = await readFile(new URL("../../../webui/src/style/theme.css", import.meta.url), "utf8");

  await assert.rejects(
    access(new URL("../../../webui/src/components/layout/AppLayout.vue", import.meta.url))
  );
  assert.doesNotMatch(theme, /--side-panel-width/);
});
