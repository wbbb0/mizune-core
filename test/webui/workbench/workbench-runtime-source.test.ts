import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("workbench shell creates, provides, and activates a runtime", async () => {
  const shell = await readFile(new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");
  const controller = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchController.ts", import.meta.url), "utf8");

  assert.match(runtime, /export function createWorkbenchRuntime/);
  assert.match(runtime, /export function provideWorkbenchRuntime/);
  assert.match(runtime, /export function useWorkbenchRuntimeContext/);
  assert.match(runtime, /export function activateWorkbenchRuntime/);
  assert.match(controller, /export function createWorkbenchController/);
  assert.match(controller, /provideWorkbenchRuntime/);
  assert.match(controller, /activateWorkbenchRuntime/);
  assert.match(shell, /createWorkbenchController/);
  assert.match(shell, /provideWorkbenchController/);
  assert.match(shell, /activateWorkbenchController/);
  assert.match(shell, /onUnmounted/);
});

test("workbench core receives navigation from the app adapter", async () => {
  const shell = await readFile(new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url), "utf8");
  const mobile = await readFile(new URL("../../../webui/src/components/workbench/MobileWorkbench.vue", import.meta.url), "utf8");
  const desktop = await readFile(new URL("../../../webui/src/components/workbench/DesktopWorkbench.vue", import.meta.url), "utf8");
  const activityBar = await readFile(new URL("../../../webui/src/components/workbench/WorkbenchActivityBar.vue", import.meta.url), "utf8");
  const viewHost = await readFile(new URL("../../../webui/src/sections/WorkbenchViewHost.vue", import.meta.url), "utf8");

  assert.match(shell, /navItems/);
  assert.match(shell, /activeNavItemId/);
  assert.match(desktop, /@navigate="emit\('navigate', \$event\)"/);
  assert.match(mobile, /props\.navItems/);
  assert.doesNotMatch(mobile, /useRoute/);
  assert.doesNotMatch(mobile, /workbenchNavItems/);
  assert.match(activityBar, /navItems/);
  assert.doesNotMatch(activityBar, /useRouter/);
  assert.doesNotMatch(activityBar, /workbenchNavItems/);
  assert.match(viewHost, /workbenchNavItems/);
  assert.match(viewHost, /router\.push\(item\.path\)/);
});

test("mobile workbench keeps root sidebar mounted under the active area overlay", async () => {
  const source = await readFile(new URL("../../../webui/src/components/workbench/MobileWorkbench.vue", import.meta.url), "utf8");
  const types = await readFile(new URL("../../../webui/src/components/workbench/types.ts", import.meta.url), "utf8");
  const sessionsView = await readFile(new URL("../../../webui/src/sections/sessions/index.ts", import.meta.url), "utf8");

  assert.match(source, /activeMobileAreaId/);
  assert.match(source, /popMobileArea/);
  assert.match(source, /layout\.mobile\.rootArea/);
  assert.doesNotMatch(source, /mobileMainFlow/);
  assert.match(types, /mobile:\s*\{/);
  assert.match(types, /rootArea:/);
  assert.doesNotMatch(types, new RegExp("main" + "Flow:"));
  assert.match(sessionsView, /defineWorkbenchView/);
  assert.doesNotMatch(sessionsView, /rootArea:\s*"primarySidebar"/);
  assert.doesNotMatch(source, /v-show="mobileScreen === 'list'"/);
});

test("mobile root area resolves to the main area when the configured root is unavailable", async () => {
  const source = await readFile(new URL("../../../webui/src/components/workbench/MobileWorkbench.vue", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");

  assert.match(runtime, /resolveMobileRootAreaId/);
  assert.match(runtime, /view\.value\.layout\.mobile\.rootArea/);
  assert.match(runtime, /return "mainArea"/);
  assert.match(source, /const hasMobileRootArea/);
  assert.match(source, /v-if="hasMobileRootArea"/);
  assert.doesNotMatch(runtime, new RegExp("hasMobile" + "ListFlow"));
});

test("mobile workbench maps browser history back to overlay stack pop", async () => {
  const source = await readFile(new URL("../../../webui/src/components/workbench/MobileWorkbench.vue", import.meta.url), "utf8");

  assert.match(source, /window\.history\.pushState/);
  assert.match(source, /window\.history\.back\(\)/);
  assert.match(source, /addEventListener\("popstate"/);
  assert.match(source, /removeEventListener\("popstate"/);
  assert.match(source, /props\.runtime\.popMobileArea\(\)/);
});

test("workbench navigation commands live in the runtime module", async () => {
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");
  const configView = await readFile(new URL("../../../webui/src/composables/sections/useConfigSection.ts", import.meta.url), "utf8");

  assert.match(runtime, /export function useWorkbenchNavigation/);
  assert.match(runtime, /activeWorkbenchRuntime\.value/);
  assert.match(runtime, /runtime\.showArea\(areaId, detailKey\)/);
  assert.match(runtime, /runtime\.showRootArea\(\)/);
  assert.doesNotMatch(runtime, new RegExp("runtime\\.show" + "Main"));
  assert.doesNotMatch(runtime, new RegExp("runtime\\.show" + "List"));
  assert.match(configView, /useWorkbenchNavigation/);
  assert.match(configView, /showArea\("mainArea"\)/);
  await assert.rejects(
    access(new URL("../../../webui/src/composables/workbench/useWorkbenchRuntime.ts", import.meta.url))
  );
});

test("workbench runtime exposes an active shell command facade", async () => {
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");
  const shell = await readFile(new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url), "utf8");
  const controller = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchController.ts", import.meta.url), "utf8");

  assert.match(runtime, /export function useActiveWorkbenchRuntime/);
  assert.match(runtime, /useWorkbenchNavigation/);
  assert.match(controller, /export function useActiveWorkbenchController/);
  assert.match(shell, /const deactivateController = activateWorkbenchController\(controller\)/);
});

test("desktop workbench sizes desktop areas through runtime resize state", async () => {
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");
  const desktop = await readFile(new URL("../../../webui/src/components/workbench/DesktopWorkbench.vue", import.meta.url), "utf8");
  const types = await readFile(new URL("../../../webui/src/components/workbench/types.ts", import.meta.url), "utf8");
  const sessionsView = await readFile(new URL("../../../webui/src/sections/sessions/index.ts", import.meta.url), "utf8");

  assert.match(types, /desktop:\s*\{/);
  assert.match(types, /primarySidebar\?:/);
  assert.match(types, /secondarySidebar\?:/);
  assert.match(types, /bottomPanel\?:/);
  assert.doesNotMatch(types, /desktopListPane/);
  assert.match(sessionsView, /defineWorkbenchView/);
  assert.doesNotMatch(sessionsView, /primarySidebar:\s*\{\}/);
  assert.match(runtime, /getDesktopAreaSizePx/);
  assert.match(runtime, /getDesktopAreaStyle/);
  assert.match(runtime, /setDesktopAreaSize/);
  assert.match(runtime, /resetDesktopAreaSize/);
  assert.match(runtime, /clampDesktopAreaSize/);
  assert.match(runtime, /layout\.desktop\[areaId\]/);
  assert.doesNotMatch(runtime, /layout\.desktopListPane/);
  assert.match(desktop, /primarySidebarStyle/);
  assert.match(desktop, /secondarySidebarStyle/);
  assert.match(desktop, /bottomPanelStyle/);
  assert.match(desktop, /getDesktopAreaStyle\("primarySidebar"\)/);
  assert.match(desktop, /setDesktopAreaSize\(areaId/);
  assert.match(desktop, /hasPrimarySidebar/);
  assert.match(desktop, /hasSecondarySidebar/);
  assert.match(desktop, /hasBottomPanel/);
  assert.match(desktop, /startDesktopAreaResize/);
  assert.match(desktop, /resetDesktopAreaResize/);
  assert.match(desktop, /role="separator"/);
  assert.match(desktop, /aria-orientation="vertical"/);
  assert.match(desktop, /aria-orientation="horizontal"/);
  assert.match(desktop, /<aside v-if="hasPrimarySidebar"/);
  assert.match(desktop, /v-if="hasPrimarySidebar"\s*\n\s*class="relative w-1/);
  assert.match(desktop, /border-r border-border-default/);
  assert.match(desktop, /@pointerdown="startDesktopAreaResize\('primarySidebar'/);
  assert.match(desktop, /@dblclick="resetDesktopAreaResize\('primarySidebar'\)"/);
  assert.doesNotMatch(desktop, /w-\(--side-panel-width\)/);
});

test("detached window and toast services resolve the active controller at call time", async () => {
  const windows = await readFile(new URL("../../../webui/src/components/workbench/windows/useWorkbenchWindows.ts", import.meta.url), "utf8");
  const toasts = await readFile(new URL("../../../webui/src/components/workbench/toasts/useWorkbenchToasts.ts", import.meta.url), "utf8");

  assert.match(windows, /dynamicWorkbenchWindows/);
  assert.match(windows, /useWorkbenchControllerContext\(\)\?\.windows \?\? dynamicWorkbenchWindows/);
  assert.match(windows, /useWorkbenchController\(\)\.windows\.openDialog/);
  assert.match(toasts, /dynamicWorkbenchToasts/);
  assert.match(toasts, /useWorkbenchControllerContext\(\)\?\.toasts \?\? dynamicWorkbenchToasts/);
  assert.match(toasts, /useWorkbenchController\(\)\.toasts\.push/);
});

test("workbench views use a definition helper for default layout", async () => {
  const types = await readFile(new URL("../../../webui/src/components/workbench/types.ts", import.meta.url), "utf8");
  const registry = await readFile(new URL("../../../webui/src/sections/registry.ts", import.meta.url), "utf8");
  const viewSources = await Promise.all(["sessions", "config", "data", "settings", "workspace"].map((name) =>
    readFile(new URL(`../../../webui/src/sections/${name}/index.ts`, import.meta.url), "utf8")
  ));

  assert.match(types, /export function defineWorkbenchView/);
  assert.match(types, /defaultWorkbenchViewLayout/);
  assert.match(registry, /defineWorkbenchView/);
  for (const source of viewSources) {
    assert.match(source, /defineWorkbenchView/);
    assert.doesNotMatch(source, /satisfies WorkbenchView/);
    assert.doesNotMatch(source, /layout:\s*\{\s*mobile:\s*\{/s);
  }
});

test("desktop workbench persists area sizes by global area id", async () => {
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");

  assert.match(runtime, /readStoredDesktopAreaSize/);
  assert.match(runtime, /writeStoredDesktopAreaSize/);
  assert.match(runtime, /localStorage/);
  assert.match(runtime, /workbench\.area\.desktop/);
  assert.match(runtime, /resolveDesktopAreaStorageKey\(areaId: DesktopAreaId\)/);
  assert.match(runtime, /readStoredDesktopAreaSize\(areaId: DesktopAreaId\)/);
  assert.match(runtime, /writeStoredDesktopAreaSize\(areaId: DesktopAreaId, sizePx: number\)/);
  assert.doesNotMatch(runtime, /desktopListPaneWidthPx/);
  for (const legacyName of [
    "readStoredDesktop" + "PaneWidth",
    "writeStoredDesktop" + "PaneWidth",
    "section" + "Id"
  ]) {
    assert.doesNotMatch(runtime, new RegExp(legacyName));
  }
  assert.match(runtime, /watch\(\(\)\s*=>\s*view\.value\.id/);
});

test("legacy app layout shell is removed after workbench runtime migration", async () => {
  const theme = await readFile(new URL("../../../webui/src/style/theme.css", import.meta.url), "utf8");

  await assert.rejects(
    access(new URL("../../../webui/src/components/layout/AppLayout.vue", import.meta.url))
  );
  assert.doesNotMatch(theme, /--side-panel-width/);
});
