import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// @ts-expect-error jsdom vendor path has no bundled declaration file in this workspace layout
import { JSDOM } from "../../../webui/node_modules/jsdom/lib/api.js";
import { resolveWindowSizing } from "../../../webui/src/components/workbench/windows/windowSizing.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const compilerSfc = require(`${ROOT}/webui/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js`);
const typescript = require(`${ROOT}/webui/node_modules/typescript/lib/typescript.js`);
const VUE_RUNTIME_URL = new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href;
const WINDOW_SIZING_URL = new URL("../../../webui/src/components/workbench/windows/windowSizing.ts", import.meta.url).href;
const USE_WORKBENCH_WINDOWS_URL = new URL("../../../webui/src/composables/workbench/useWorkbenchWindows.ts", import.meta.url).href;
const WORKBENCH_RUNTIME_URL = new URL("../../../webui/src/components/workbench/runtime/workbenchRuntime.ts", import.meta.url).href;
const WINDOW_SURFACE_PATH = `${ROOT}/webui/src/components/workbench/windows/WindowSurface.vue`;
const WINDOW_HOST_PATH = `${ROOT}/webui/src/components/workbench/windows/WindowHost.vue`;
const DIALOG_RENDERER_PATH = `${ROOT}/webui/src/components/workbench/windows/DialogRenderer.vue`;
const WORKBENCH_SHELL_PATH = `${ROOT}/webui/src/components/workbench/WorkbenchShell.vue`;

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

const { nextTick, markRaw } = await import(VUE_RUNTIME_URL);
const { useWorkbenchWindows } = await import(USE_WORKBENCH_WINDOWS_URL);

function createDataModule(source: string) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

const vueStubUrl = createDataModule(`
  export * from "${VUE_RUNTIME_URL}";
`);

const uiStubUrl = createDataModule(`
  import { reactive } from "${VUE_RUNTIME_URL}";
  export const uiState = reactive({ isMobile: false });
  export function useUiStore() {
    return uiState;
  }
`);

const routeStubUrl = createDataModule(`
  import { reactive } from "${VUE_RUNTIME_URL}";
  export const routeState = reactive({ name: "sessions" });
  export function useRoute() {
    return routeState;
  }
`);

const activityBarStubUrl = createDataModule(`
  import { h } from "${VUE_RUNTIME_URL}";
  export default {
    name: "ActivityBar",
    render() {
      return h("div", { "data-test": "activity-bar" }, "ActivityBar");
    }
  };
`);

const desktopWorkbenchStubUrl = createDataModule(`
  import { h } from "${VUE_RUNTIME_URL}";
  export default {
    name: "DesktopWorkbench",
    props: { section: { type: Object, required: true } },
    render() {
      return h("div", { "data-test": "desktop-workbench" }, this.section?.title ?? "");
    }
  };
`);

const mobileWorkbenchStubUrl = createDataModule(`
  import { h } from "${VUE_RUNTIME_URL}";
  export default {
    name: "MobileWorkbench",
    render() {
      return h("div", { "data-test": "mobile-workbench" }, "mobile");
    }
  };
`);

const menuHostStubUrl = createDataModule(`
  import { h } from "${VUE_RUNTIME_URL}";
  export default {
    name: "MenuHost",
    render() {
      return h("div", { "data-test": "menu-host" });
    }
  };
`);

const workbenchNavItemsStubUrl = createDataModule(`
  export const workbenchNavItems = [];
`);

const menuRuntimeStubUrl = createDataModule(`
  export function useMenuRuntime() {
    return {
      closeAllMenus() {}
    };
  }
`);

const { uiState } = await import(uiStubUrl);
const { routeState } = await import(routeStubUrl);
const testUtilsUrl = new URL("../../../webui/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs", import.meta.url).href;
const vueTestUtils = await import(testUtilsUrl);
const { mount: vueMount } = vueTestUtils;

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

const windowSurfaceUrl = compileVueModule(WINDOW_SURFACE_PATH, {
  vue: vueStubUrl,
  "lucide-vue-next": createDataModule(`
    import { h } from "${VUE_RUNTIME_URL}";
    export const X = { name: "X", render() { return h("span", { "data-test": "icon-x" }); } };
  `),
  "./windowSizing": WINDOW_SIZING_URL
});

const dialogRendererUrl = compileVueModule(DIALOG_RENDERER_PATH, {
  vue: vueStubUrl,
  "./types.js": new URL("../../../webui/src/components/workbench/windows/types.ts", import.meta.url).href
});

const windowHostUrl = compileVueModule(WINDOW_HOST_PATH, {
  vue: vueStubUrl,
  "@/stores/ui": uiStubUrl,
  "@/composables/workbench/useWorkbenchWindows": USE_WORKBENCH_WINDOWS_URL,
  "./DialogRenderer.vue": dialogRendererUrl,
  "./WindowSurface.vue": windowSurfaceUrl
});

const workbenchShellUrl = compileVueModule(WORKBENCH_SHELL_PATH, {
  vue: vueStubUrl,
  "@/components/workbench/DesktopWorkbench.vue": desktopWorkbenchStubUrl,
  "@/components/workbench/MobileWorkbench.vue": mobileWorkbenchStubUrl,
  "@/components/workbench/menu/MenuHost.vue": menuHostStubUrl,
  "@/stores/ui": uiStubUrl,
  "@/components/workbench/runtime/workbenchRuntime": WORKBENCH_RUNTIME_URL,
  "@/composables/workbench/menu/useMenuRuntime": menuRuntimeStubUrl,
  "@/composables/workbench/useWorkbenchWindows": USE_WORKBENCH_WINDOWS_URL,
  "@/components/workbench/windows/WindowHost.vue": windowHostUrl
});

const windowManager = useWorkbenchWindows();

function resetWindows() {
  for (const window of [...windowManager.snapshot()].reverse()) {
    windowManager.close(window.id, {
      reason: "dismiss",
      values: {}
    });
  }
}

function buildWindow(id: string, parentId?: string) {
  return {
    id,
    kind: parentId ? "child-dialog" : "dialog",
    title: id,
    size: "md" as const,
    parentId
  };
}

async function mountComponent(componentUrl: string, props: Record<string, unknown>, stubs?: Record<string, unknown>) {
  const component = (await import(componentUrl)).default;
  return vueMount(component, {
    props,
    global: {
      stubs: {
        ...(stubs ?? {})
      }
    }
  });
}

test.beforeEach(() => {
  uiState.isMobile = false;
  routeState.name = "sessions";
  resetWindows();
});

test.afterEach(() => {
  uiState.isMobile = false;
  routeState.name = "sessions";
  resetWindows();
});

test("window sizing resolves desktop sizes and mobile full-screen bounds", () => {
  assert.match(resolveWindowSizing("auto", false).className, /w-auto/);
  assert.match(resolveWindowSizing("auto", false).className, /max-w-\[/);
  assert.match(resolveWindowSizing("md", false).style.maxHeight ?? "", /env\(safe-area-inset-top/);
  assert.match(resolveWindowSizing("sm", false).className, /max-w-sm/);
  assert.match(resolveWindowSizing("md", false).className, /max-w-md/);

  const fullDesktop = resolveWindowSizing("full", false);
  assert.match(fullDesktop.style.width ?? "", /env\(safe-area-inset-left/);
  assert.match(fullDesktop.style.height ?? "", /env\(safe-area-inset-top/);

  const mobile = resolveWindowSizing("xl", true);
  assert.match(mobile.className, /w-full/);
  assert.match(mobile.className, /max-w-none/);
});

test("window host renders all desktop windows in manager order", async () => {
  uiState.isMobile = false;
  const wrapper = await mountComponent(windowHostUrl, {});

  windowManager.openSync(buildWindow("parent"));
  windowManager.openSync(buildWindow("child", "parent"));
  await nextTick();

  const sections = wrapper.findAll("section");
  assert.equal(sections.length, 2);
  assert.match(sections[0]!.text(), /parent/);
  assert.match(sections[1]!.text(), /child/);
  assert.match(wrapper.text(), /暂无窗口内容/);
  assert.match(wrapper.html(), /window-inactive/);
});

test("window host routes schema windows through dialog renderer and closes on resolve", async () => {
  uiState.isMobile = false;
  const wrapper = await mountComponent(windowHostUrl, {});

  windowManager.openSync({
    id: "schema-window",
    kind: "dialog",
    title: "带表单窗口",
    size: "md",
    schema: {
      fields: [
        {
          kind: "string",
          key: "title",
          label: "标题",
          defaultValue: "初始值"
        }
      ]
    },
    actions: [
      {
        id: "save",
        label: "保存"
      }
    ]
  });
  await nextTick();

  assert.match(wrapper.html(), /data-action-id="save"/);
  await wrapper.get('[data-action-id="save"]').trigger("click");
  await nextTick();
  assert.equal(windowManager.snapshot().length, 0);
});

test("window host renders only the top window on mobile", async () => {
  uiState.isMobile = true;
  const wrapper = await mountComponent(windowHostUrl, {});

  windowManager.openSync(buildWindow("parent"));
  windowManager.openSync(buildWindow("child", "parent"));
  await nextTick();

  const sections = wrapper.findAll("section");
  assert.equal(sections.length, 1);
  assert.match(sections[0]!.text(), /child/);
  assert.doesNotMatch(wrapper.html(), /parent/);
});

test("window host focuses a desktop window when it is pressed", async () => {
  uiState.isMobile = false;
  const wrapper = await mountComponent(windowHostUrl, {});

  windowManager.openSync(buildWindow("parent"));
  windowManager.openSync(buildWindow("sibling"));
  windowManager.openSync(buildWindow("child", "parent"));
  await nextTick();

  const before = wrapper.findAll("section").map((section: ReturnType<typeof wrapper.find>) => section.text());
  assert.deepEqual(before.map((text: string) => text.includes("parent") ? "parent" : text.includes("sibling") ? "sibling" : "child"), ["parent", "sibling", "child"]);

  await wrapper.findAll("section")[0]!.trigger("pointerdown");
  await nextTick();

  const after = wrapper.findAll("section").map((section: ReturnType<typeof wrapper.find>) => section.text());
  assert.deepEqual(after.map((text: string) => text.includes("parent") ? "parent" : text.includes("sibling") ? "sibling" : "child"), ["sibling", "parent", "child"]);
});

test("window host focuses an inactive window when an input inside it receives focus", async () => {
  uiState.isMobile = false;
  const wrapper = await mountComponent(windowHostUrl, {});

  windowManager.openSync({
    id: "dialog-with-input",
    kind: "dialog",
    title: "dialog-with-input",
    size: "md",
    schema: {
      fields: [
        {
          kind: "string",
          key: "title",
          label: "标题",
          defaultValue: "初始值"
        }
      ]
    }
  });
  windowManager.openSync(buildWindow("sibling"));
  await nextTick();

  const before = wrapper.findAll("section").map((section: ReturnType<typeof wrapper.find>) => section.text());
  assert.deepEqual(before.map((text: string) => text.includes("dialog-with-input") ? "dialog-with-input" : "sibling"), ["dialog-with-input", "sibling"]);

  await wrapper.get('input[type="text"]').trigger("focusin");
  await nextTick();

  const after = wrapper.findAll("section").map((section: ReturnType<typeof wrapper.find>) => section.text());
  assert.deepEqual(after.map((text: string) => text.includes("dialog-with-input") ? "dialog-with-input" : "sibling"), ["sibling", "dialog-with-input"]);
});

test("window host moves a desktop window when dragging its title bar", async () => {
  uiState.isMobile = false;
  const wrapper = await mountComponent(windowHostUrl, {});

  windowManager.openSync(buildWindow("draggable"));
  await nextTick();

  const header = wrapper.get("header");
  header.element.dispatchEvent(new window.PointerEvent("pointerdown", {
    bubbles: true,
    clientX: 100,
    clientY: 120
  }));
  window.dispatchEvent(new window.PointerEvent("pointermove", {
    bubbles: true,
    clientX: 145,
    clientY: 170
  }));
  window.dispatchEvent(new window.PointerEvent("pointerup", {
    bubbles: true,
    clientX: 145,
    clientY: 170
  }));
  await nextTick();

  assert.deepEqual(windowManager.get("draggable")?.position, { x: 45, y: 50 });
});

test("window host clamps dragging so a window always keeps a visible grab area", async () => {
  uiState.isMobile = false;
  const wrapper = await mountComponent(windowHostUrl, {});

  windowManager.openSync(buildWindow("clamped"));
  await nextTick();

  const section = wrapper.get("section").element as HTMLElement;
  const header = wrapper.get("header").element as HTMLElement;
  Object.defineProperty(section, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width: 400,
      height: 280,
      top: 0,
      left: 0,
      right: 400,
      bottom: 280,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      }
    })
  });
  Object.defineProperty(header, "offsetHeight", {
    configurable: true,
    value: 48
  });

  header.dispatchEvent(new window.PointerEvent("pointerdown", {
    bubbles: true,
    clientX: 120,
    clientY: 120
  }));
  window.dispatchEvent(new window.PointerEvent("pointermove", {
    bubbles: true,
    clientX: -2000,
    clientY: -2000
  }));
  window.dispatchEvent(new window.PointerEvent("pointerup", {
    bubbles: true,
    clientX: -2000,
    clientY: -2000
  }));
  await nextTick();

  assert.deepEqual(windowManager.get("clamped")?.position, { x: -656, y: -244 });
});

test("window host renders a single modal backdrop and closes the top modal on backdrop click when allowed", async () => {
  uiState.isMobile = false;
  const wrapper = await mountComponent(windowHostUrl, {});

  const opening = windowManager.open({
    id: "modal-window",
    kind: "dialog",
    title: "modal-window",
    size: "md",
    modal: true,
    closeOnBackdrop: true
  });
  windowManager.openSync({
    id: "child-modal",
    kind: "child-dialog",
    title: "child-modal",
    size: "sm",
    parentId: "modal-window",
    modal: true,
    closeOnBackdrop: true
  });
  await nextTick();

  assert.equal(wrapper.findAll('[data-test="window-backdrop"]').length, 1);
  await wrapper.get('[data-test="window-backdrop"]').trigger("click");
  await nextTick();

  assert.equal(windowManager.get("child-modal"), undefined);
  assert.notEqual(windowManager.get("modal-window"), undefined);
  windowManager.close("modal-window", { reason: "dismiss", values: {} });
  await assert.deepEqual(await opening, { reason: "dismiss", values: {} });
});

test("window surface hides the close button when actions are present by default", async () => {
  const WindowSurface = (await import(windowSurfaceUrl)).default;
  const wrapper = vueMount(WindowSurface, {
    props: {
      isMobile: false,
      inactive: false,
      window: {
        id: "action-window",
        order: 1,
        position: { x: 0, y: 0 },
        definition: {
          title: "Action Window",
          size: "md",
          actions: [{ id: "confirm", label: "确认" }]
        }
      }
    }
  });

  await nextTick();
  assert.equal(wrapper.find('button[title="关闭"]').exists(), false);
});

test("window host closes a window with an explicit close result", async () => {
  uiState.isMobile = false;
  const opening = windowManager.open({
    id: "closable",
    kind: "dialog",
    title: "closable",
    size: "auto",
    schema: {
      fields: [
        {
          kind: "string",
          key: "title",
          label: "标题",
          defaultValue: "初始值"
        }
      ]
    }
  });
  const wrapper = await mountComponent(windowHostUrl, {});
  await nextTick();

  await wrapper.get('input[type="text"]').setValue("关闭前的值");
  await wrapper.find('button[title="关闭"]').trigger("click");

  assert.deepEqual(await opening, {
    reason: "close",
    values: {
      title: "关闭前的值"
    }
  });
});

test("window host dismisses a modal with the current values on backdrop click", async () => {
  uiState.isMobile = false;
  const opening = windowManager.open({
    id: "backdrop-values",
    kind: "dialog",
    title: "backdrop-values",
    size: "md",
    modal: true,
    closeOnBackdrop: true,
    schema: {
      fields: [
        {
          kind: "string",
          key: "note",
          label: "备注",
          defaultValue: "初始备注"
        }
      ]
    }
  });
  const wrapper = await mountComponent(windowHostUrl, {});
  await nextTick();

  await wrapper.get('input[type="text"]').setValue("遮罩关闭值");
  await wrapper.get('[data-test="window-backdrop"]').trigger("click");

  assert.deepEqual(await opening, {
    reason: "dismiss",
    values: {
      note: "遮罩关闭值"
    }
  });
});

test("window host only closes the top escape-enabled window on Escape", async () => {
  uiState.isMobile = false;
  const nonClosable = windowManager.open({
    id: "escape-disabled",
    kind: "dialog",
    title: "escape-disabled",
    size: "md",
    closeOnEscape: false,
    schema: {
      fields: [
        {
          kind: "string",
          key: "name",
          label: "名称",
          defaultValue: "不会关闭"
        }
      ]
    }
  });
  const closable = windowManager.open({
    id: "escape-enabled",
    kind: "dialog",
    title: "escape-enabled",
    size: "md",
    closeOnEscape: true,
    schema: {
      fields: [
        {
          kind: "string",
          key: "name",
          label: "名称",
          defaultValue: "会关闭"
        }
      ]
    }
  });
  const wrapper = await mountComponent(windowHostUrl, {});
  await nextTick();

  window.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true
  }));
  await nextTick();

  assert.equal(windowManager.get("escape-enabled"), undefined);
  assert.notEqual(windowManager.get("escape-disabled"), undefined);
  assert.deepEqual(await closable, {
    reason: "dismiss",
    values: {
      name: "会关闭"
    }
  });

  window.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true
  }));
  await nextTick();

  assert.notEqual(windowManager.get("escape-disabled"), undefined);
  windowManager.close("escape-disabled", {
    reason: "dismiss",
    values: {
      name: "底层值"
    }
  });
  assert.deepEqual(await nonClosable, {
    reason: "dismiss",
    values: {
      name: "底层值"
    }
  });
});

test("window surface keeps inactive styling and visible transform and size output", async () => {
  const WindowSurface = (await import(windowSurfaceUrl)).default;
  const wrapper = vueMount(WindowSurface, {
    props: {
      isMobile: false,
      inactive: true,
      window: {
        id: "surface",
        order: 2,
        position: { x: 10, y: 20 },
        definition: {
          title: "Surface",
          description: "Description",
          size: "auto"
        }
      }
    }
  });

  await nextTick();

  assert.ok(wrapper.classes().includes("window-inactive"));
  assert.ok(wrapper.classes().includes("w-auto"));
  assert.match(wrapper.element.getAttribute("style") ?? "", /translate3d\(calc\(-50% \+ 10px\), calc\(-50% \+ 20px\), 0\)/);
  assert.match(wrapper.element.getAttribute("style") ?? "", /max-height:/);
  assert.equal(wrapper.attributes("aria-disabled"), "true");
  assert.match(wrapper.text(), /Surface/);
  assert.match(wrapper.text(), /Description/);
});

test("workbench shell mounts the window host and delegates layout to the desktop shell", async () => {
  const WindowHost = (await import(windowHostUrl)).default;
  const WorkbenchShell = (await import(workbenchShellUrl)).default;

  windowManager.openSync(buildWindow("shell-window"));
  const wrapper = vueMount(WorkbenchShell, {
    props: {
      section: {
        title: "Workbench",
        layout: { mobileMainFlow: "list-only" },
        regions: {
          listPane: markRaw({
            name: "ListPane",
            render() {
              return null;
            }
          }),
          mainPane: markRaw({
            name: "MainPane",
            render() {
              return null;
            }
          }),
          mobileHeader: markRaw({
            name: "MobileHeader",
            render() {
              return null;
            }
          })
        }
      }
      ,
      topbarMenus: [],
      statusbarItems: []
    },
    global: {
      stubs: {
        RouterLink: true
      }
    }
  });

  await nextTick();

  assert.ok(wrapper.findComponent(WindowHost).exists());
  assert.match(wrapper.text(), /shell-window/);
  assert.equal(wrapper.find('[data-test="desktop-workbench"]').exists(), true);
  assert.equal(wrapper.find('[data-test="menu-host"]').exists(), true);
  assert.match(wrapper.html(), /fixed inset-0 z-60 overflow-hidden/);
});
