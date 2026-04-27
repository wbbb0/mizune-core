/// <reference lib="dom" />

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// @ts-expect-error jsdom vendor path has no bundled declaration file in this workspace layout
import { JSDOM } from "../../../webui/node_modules/jsdom/lib/api.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const compilerSfc = require(`${ROOT}/webui/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js`);
const typescript = require(`${ROOT}/webui/node_modules/typescript/lib/typescript.js`);
const VUE_RUNTIME_URL = new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href;
const VUE_TEST_UTILS_URL = new URL("../../../webui/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs", import.meta.url).href;
const USE_WORKBENCH_WINDOWS_URL = new URL("../../../webui/src/composables/workbench/useWorkbenchWindows.ts", import.meta.url).href;
const WORKBENCH_DIALOG_PATH = `${ROOT}/webui/src/components/workbench/windows/WorkbenchDialog.vue`;

const dom = new JSDOM("<!doctype html><html><body></body></html>");

Object.defineProperty(globalThis, "window", { value: dom.window });
Object.defineProperty(globalThis, "document", { value: dom.window.document });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });
Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement });
Object.defineProperty(globalThis, "SVGElement", { value: dom.window.SVGElement });
Object.defineProperty(globalThis, "Element", { value: dom.window.Element });
Object.defineProperty(globalThis, "Node", { value: dom.window.Node });
Object.defineProperty(globalThis, "getComputedStyle", {
  value: dom.window.getComputedStyle.bind(dom.window)
});
Object.defineProperty(globalThis, "MutationObserver", { value: dom.window.MutationObserver });

function createDataModule(source: string) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

const vueStubUrl = createDataModule(`
  export * from "${VUE_RUNTIME_URL}";
`);

const compiledModuleCache = new Map<string, string>();

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceImports(source: string, replacements: Record<string, string>) {
  let nextSource = source;
  for (const [from, to] of Object.entries(replacements)) {
    const pattern = new RegExp(`from\\s+(['"])${escapeRegExp(from)}\\1`, "g");
    nextSource = nextSource.replace(pattern, `from $1${to}$1`);
  }
  return nextSource;
}

function compileVueModule(filePath: string, replacements: Record<string, string>) {
  const cacheKey = `${filePath}::${JSON.stringify(replacements)}`;
  const cached = compiledModuleCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const source = readFileSync(filePath, "utf8");
  const { descriptor } = compilerSfc.parse(source, { filename: filePath });
  const compiled = compilerSfc.compileScript(descriptor, { id: filePath, inlineTemplate: true }).content;
  const transpiled = typescript.transpileModule(compiled, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2020,
      module: typescript.ModuleKind.ESNext
    }
  }).outputText;

  const moduleUrl = createDataModule(replaceImports(transpiled, replacements));
  compiledModuleCache.set(cacheKey, moduleUrl);
  return moduleUrl;
}

const workbenchDialogUrl = compileVueModule(WORKBENCH_DIALOG_PATH, {
  vue: vueStubUrl,
  "@/composables/workbench/useWorkbenchWindows": USE_WORKBENCH_WINDOWS_URL
});

const vueTestUtils = await import(VUE_TEST_UTILS_URL);
const { mount: vueMount } = vueTestUtils;
const { nextTick } = await import(VUE_RUNTIME_URL);
const { default: WorkbenchDialog } = await import(workbenchDialogUrl);
const { useWorkbenchWindows } = await import(USE_WORKBENCH_WINDOWS_URL);

const windowManager = useWorkbenchWindows();

function resetWindows() {
  for (const window of [...windowManager.snapshot()].reverse()) {
    windowManager.close(window.id, {
      reason: "dismiss",
      values: {}
    });
  }
}

test.beforeEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "scroll";
  resetWindows();
});

test.afterEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "";
  resetWindows();
});

test("WorkbenchDialog does not change body overflow while syncing with the window host", async () => {
  const wrapper = vueMount(WorkbenchDialog, {
    props: {
      open: true,
      title: "兼容弹窗"
    }
  });
  await nextTick();

  assert.equal(document.body.style.overflow, "scroll");

  await wrapper.setProps({ open: false });
  await nextTick();

  assert.equal(document.body.style.overflow, "scroll");
});

test("WorkbenchDialog forwards closeOnEscape to the window system instead of always closing on Escape", async () => {
  const wrapper = vueMount(WorkbenchDialog, {
    props: {
      open: true,
      title: "兼容弹窗",
      closeOnEscape: false
    }
  });
  await nextTick();

  const openedWindow = windowManager.snapshot()[0];
  assert.ok(openedWindow);
  assert.equal(openedWindow?.definition.closeOnEscape, false);

  window.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true
  }));
  await nextTick();

  assert.equal(wrapper.emitted("close"), undefined);
  assert.equal(windowManager.snapshot().length, 1);
});
