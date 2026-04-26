import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

  assert.match(source, /isMobileMainVisible/);
  assert.match(source, /popMobileRegion/);
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

test("legacy workbench runtime wrapper delegates to active runtime", async () => {
  const source = await readFile(new URL("../../../webui/src/composables/workbench/useWorkbenchRuntime.ts", import.meta.url), "utf8");

  assert.match(source, /useActiveWorkbenchRuntime/);
  assert.match(source, /activeRuntime\.value/);
  assert.doesNotMatch(source, /useWorkbenchRuntimeContext/);
});

test("workbench runtime exposes an active shell command facade", async () => {
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");
  const wrapper = await readFile(new URL("../../../webui/src/composables/workbench/useWorkbenchRuntime.ts", import.meta.url), "utf8");
  const shell = await readFile(new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url), "utf8");

  assert.match(runtime, /export function useActiveWorkbenchRuntime/);
  assert.match(wrapper, /useActiveWorkbenchRuntime/);
  assert.match(wrapper, /runtime\.showMain\(detailKey\)/);
  assert.match(wrapper, /runtime\.showList\(\)/);
  assert.match(shell, /const deactivateRuntime = activateWorkbenchRuntime\(runtime\)/);
});
