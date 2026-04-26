import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("workbench shell creates and provides a runtime", async () => {
  const shell = await readFile(new URL("../../../webui/src/components/workbench/WorkbenchShell.vue", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url), "utf8");

  assert.match(runtime, /export function createWorkbenchRuntime/);
  assert.match(runtime, /export function provideWorkbenchRuntime/);
  assert.match(runtime, /export function useWorkbenchRuntimeContext/);
  assert.match(shell, /createWorkbenchRuntime/);
  assert.match(shell, /provideWorkbenchRuntime/);
});

test("mobile workbench keeps list mounted under the main overlay", async () => {
  const source = await readFile(new URL("../../../webui/src/components/workbench/MobileWorkbench.vue", import.meta.url), "utf8");

  assert.match(source, /isMobileMainVisible/);
  assert.match(source, /popMobileRegion/);
  assert.doesNotMatch(source, /v-show="mobileScreen === 'list'"/);
});

test("legacy workbench runtime wrapper delegates to provided runtime", async () => {
  const source = await readFile(new URL("../../../webui/src/composables/workbench/useWorkbenchRuntime.ts", import.meta.url), "utf8");

  assert.match(source, /useWorkbenchRuntimeContext/);
  assert.match(source, /providedRuntime \?\?/);
});
