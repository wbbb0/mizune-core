/// <reference lib="dom" />

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// @ts-expect-error jsdom vendor path has no bundled declaration file in this workspace layout
import { JSDOM } from "../../../webui/node_modules/jsdom/lib/api.js";
import type { WorkbenchDialogField, WorkbenchWindowDefinition } from "../../../webui/src/components/workbench/windows/types.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const compilerSfc = require(`${ROOT}/webui/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js`);
const typescript = require(`${ROOT}/webui/node_modules/typescript/lib/typescript.js`);
const VUE_RUNTIME_URL = new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href;
const VUE_TEST_UTILS_URL = new URL("../../../webui/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs", import.meta.url).href;
const DIALOG_RENDERER_PATH = `${ROOT}/webui/src/components/workbench/windows/DialogRenderer.vue`;
const TYPES_URL = new URL("../../../webui/src/components/workbench/windows/types.ts", import.meta.url).href;

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

const customBlockStubUrl = createDataModule(`
  import { h } from "${VUE_RUNTIME_URL}";
  export default {
    name: "CustomBlockStub",
    props: {
      label: { type: String, default: "" }
    },
    render() {
      return h("div", { "data-test": "custom-block", "data-label": this.label }, this.label);
    }
  };
`);

const groupCustomFieldStubUrl = createDataModule(`
  import { h } from "${VUE_RUNTIME_URL}";
  export default {
    name: "GroupCustomFieldStub",
    props: {
      modelValue: { default: "" }
    },
    emits: ["update:modelValue"],
    render() {
      return h("button", {
        type: "button",
        "data-test": "group-custom-field",
        "data-value": String(this.modelValue ?? ""),
        onClick: () => this.$emit("update:modelValue", "group-updated")
      }, String(this.modelValue ?? ""));
    }
  };
`);

const dialogRendererUrl = compileVueModule(DIALOG_RENDERER_PATH, {
  vue: vueStubUrl,
  "./types.js": TYPES_URL
});

const vueTestUtils = await import(VUE_TEST_UTILS_URL);
const { mount: vueMount } = vueTestUtils;
const { default: DialogRenderer } = await import(dialogRendererUrl);
const { default: CustomBlockStub } = await import(customBlockStubUrl);
const { default: GroupCustomFieldStub } = await import(groupCustomFieldStubUrl);

const typedGroupDefinition = {
  kind: "dialog",
  title: "类型约束",
  size: "md",
  schema: {
    fields: [
      {
        kind: "group",
        key: "profile",
        label: "资料",
        fields: [
          {
            kind: "custom",
            key: "alias",
            label: "别名",
            component: GroupCustomFieldStub
          }
        ]
      }
    ]
  }
} satisfies WorkbenchWindowDefinition<{ profile: { alias: string } }>;

const invalidNestedGroupDefinition = {
  kind: "dialog",
  title: "类型约束-嵌套",
  size: "md",
  schema: {
    fields: [
      {
        kind: "group",
        key: "profile",
        label: "资料",
        fields: [
          {
            // @ts-expect-error group 内不再支持嵌套 group
            kind: "group",
            key: "nested",
            label: "嵌套",
            fields: []
          }
        ]
      }
    ]
  }
} satisfies WorkbenchWindowDefinition<{ profile: { nested: { alias: string } } }>;

test.beforeEach(() => {
  document.body.innerHTML = "";
});

test("dialog actions can wrap inside narrow mobile dialogs", () => {
  const source = readFileSync(DIALOG_RENDERER_PATH, "utf8");

  assert.match(source, /flex flex-wrap items-center justify-end gap-2 border-t/);
  assert.match(source, /btn btn-secondary max-w-full whitespace-normal text-left/);
  assert.match(source, /max-w-full whitespace-normal text-left/);
});

function buildDefinition(runCalls?: Array<{ values: Record<string, unknown>; windowId: string }>) {
  return {
    kind: "dialog",
    title: "示例对话框",
    size: "md" as const,
    schema: {
      fields: [
        {
          kind: "string" as const,
          key: "title",
          label: "标题",
          defaultValue: "初始标题",
          placeholder: "请输入标题",
          required: true
        },
        {
          kind: "boolean" as const,
          key: "enabled",
          label: "启用",
          defaultValue: false
        }
      ]
    },
    blocks: [],
    actions: [
      {
        id: "save",
        label: "保存",
        run: async (context: { values: Record<string, unknown>; windowId: string }) => {
          runCalls?.push(context);
          return { saved: true, windowId: context.windowId, values: context.values };
        }
      }
    ]
  };
}

test("dialog renderer type bindings keep group children aligned with the group value type", () => {
  const groupField = typedGroupDefinition.schema.fields[0];
  assert.ok(groupField);
  assert.equal(groupField.kind, "group");

  const fields: WorkbenchDialogField<{ alias: string }>[] = groupField.kind === "group" ? groupField.fields : [];
  assert.equal(fields.length, 1);
  assert.equal(fields[0]?.key, "alias");
});

test("dialog renderer preserves values when an equivalent definition is re-passed", async () => {
  const runCalls: Array<{ values: Record<string, unknown>; windowId: string }> = [];
  const wrapper = vueMount(DialogRenderer, {
    props: {
      windowId: "dialog-1",
      definition: buildDefinition(runCalls)
    }
  });

  await wrapper.find('input[type="text"]').setValue("更新后的标题");
  await wrapper.find('input[type="checkbox"]').setValue(true);
  await wrapper.setProps({
    definition: buildDefinition(runCalls)
  });
  assert.equal((wrapper.find('input[type="text"]').element as HTMLInputElement).value, "更新后的标题");
  assert.equal((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked, true);
  await wrapper.get('[data-action-id="save"]').trigger("click");

  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0], {
    windowId: "dialog-1",
    values: {
      title: "更新后的标题",
      enabled: true
    }
  });

  const emitted = wrapper.emitted("resolve");
  assert.ok(emitted);
  assert.equal(emitted?.length, 1);
  assert.deepEqual(emitted?.[0]?.[0], {
    reason: "action",
    actionId: "save",
    values: {
      title: "更新后的标题",
      enabled: true
    },
    result: {
      saved: true,
      windowId: "dialog-1",
      values: {
        title: "更新后的标题",
        enabled: true
      }
    }
  });
});

test("dialog renderer submits a number for a cleared number field", async () => {
  const runCalls: Array<{ values: Record<string, unknown>; windowId: string }> = [];
  const wrapper = vueMount(DialogRenderer, {
    props: {
      windowId: "dialog-number",
      definition: {
        kind: "dialog",
        title: "数字字段",
        size: "md",
        schema: {
          fields: [
            {
              kind: "number",
              key: "count",
              label: "数量",
              min: 7
            }
          ]
        },
        actions: [
          {
            id: "save",
            label: "保存",
            run: (context: { values: Record<string, unknown>; windowId: string }) => {
              runCalls.push(context);
              return context.values;
            }
          }
        ]
      }
    }
  });

  const input = wrapper.find('input[type="number"]');
  assert.equal((input.element as HTMLInputElement).value, "7");
  await input.setValue("");
  await wrapper.get('[data-action-id="save"]').trigger("click");

  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0]?.values, {
    count: 7
  });

  const emitted = wrapper.emitted("resolve");
  assert.ok(emitted);
  assert.deepEqual(emitted?.[0]?.[0], {
    reason: "action",
    actionId: "save",
    values: {
      count: 7
    },
    result: {
      count: 7
    }
  });
});

test("dialog renderer keeps group custom field reads and writes on the same path", async () => {
  const wrapper = vueMount(DialogRenderer, {
    props: {
      windowId: "dialog-2",
      definition: {
        kind: "dialog",
        title: "组内自定义字段",
        size: "md",
        schema: {
          fields: [
            {
              kind: "group",
              key: "profile",
              label: "资料",
              fields: [
                {
                  kind: "custom",
                  key: "alias",
                  label: "别名",
                  component: GroupCustomFieldStub
                }
              ]
            }
          ]
        },
        actions: []
      }
    }
  });

  assert.equal(wrapper.get('[data-test="group-custom-field"]').attributes("data-value"), "");
  await wrapper.get('[data-test="group-custom-field"]').trigger("click");
  assert.equal(wrapper.get('[data-test="group-custom-field"]').attributes("data-value"), "group-updated");
  await wrapper.get('[data-action-kind="close"]').trigger("click");

  const emitted = wrapper.emitted("resolve");
  assert.ok(emitted);
  assert.equal(emitted?.length, 1);
  assert.deepEqual(emitted?.[0]?.[0], {
    reason: "close",
    values: {
      profile: {
        alias: "group-updated"
      }
    }
  });
});

test("dialog renderer disables all actions and close while one action is running", async () => {
  let resolveAction: (() => void) | undefined;
  const actionStarted = new Promise<void>((resolve) => {
    resolveAction = resolve;
  });
  const runCalls: Array<string> = [];

  const wrapper = vueMount(DialogRenderer, {
    props: {
      windowId: "dialog-3",
      definition: {
        kind: "dialog",
        title: "忙碌态",
        size: "md",
        schema: {
          fields: [
            {
              kind: "string",
              key: "name",
              label: "名称",
              defaultValue: "默认名称"
            }
          ]
        },
        actions: [
          {
            id: "save",
            label: "保存",
            run: async () => {
              runCalls.push("save");
              await actionStarted;
              return { saved: true };
            }
          },
          {
            id: "secondary",
            label: "次要动作",
            variant: "secondary",
            run: () => {
              runCalls.push("secondary");
              return { saved: "secondary" };
            }
          }
        ]
      }
    }
  });

  await wrapper.find('input[type="text"]').setValue("已修改名称");
  await wrapper.get('[data-action-id="save"]').trigger("click");

  assert.equal(runCalls.length, 1);
  assert.equal((wrapper.get('[data-action-id="save"]').element as HTMLButtonElement).disabled, true);
  assert.equal((wrapper.get('[data-action-id="secondary"]').element as HTMLButtonElement).disabled, true);
  assert.equal((wrapper.get('[data-action-kind="close"]').element as HTMLButtonElement).disabled, true);

  (wrapper.get('[data-action-id="secondary"]').element as HTMLButtonElement).click();
  (wrapper.get('[data-action-kind="close"]').element as HTMLButtonElement).click();
  assert.equal(runCalls.length, 1);
  assert.equal(wrapper.emitted("resolve"), undefined);

  resolveAction?.();
  await actionStarted;
  await Promise.resolve();
  await Promise.resolve();

  const emitted = wrapper.emitted("resolve");
  assert.ok(emitted);
  assert.equal(emitted?.length, 1);
  assert.deepEqual(emitted?.[0]?.[0], {
    reason: "action",
    actionId: "save",
    values: {
      name: "已修改名称"
    },
    result: { saved: true }
  });
});

test("dialog renderer mounts supported blocks and fields", async () => {
  const wrapper = vueMount(DialogRenderer, {
    props: {
      windowId: "dialog-4",
      definition: {
        kind: "dialog",
        title: "渲染测试",
        size: "md",
        schema: {
          fields: [
            {
              kind: "string",
              key: "name",
              label: "名称",
              placeholder: "输入名称"
            },
            {
              kind: "boolean",
              key: "visible",
              label: "可见"
            }
          ]
        },
        blocks: [
          { kind: "text", content: "第一段文案" },
          { kind: "separator" },
          {
            kind: "component",
            component: CustomBlockStub,
            props: { label: "块组件" }
          }
        ],
        actions: [
          {
            id: "noop",
            label: "确认"
          }
        ]
      }
    }
  });

  assert.match(wrapper.text(), /第一段文案/);
  assert.equal(wrapper.findAll("hr").length, 1);
  assert.equal(wrapper.find('[data-test="custom-block"]').attributes("data-label"), "块组件");
  assert.equal(wrapper.find('input[type="text"]').attributes("placeholder"), "输入名称");
  assert.equal(wrapper.find('input[type="checkbox"]').exists(), true);
});

test("dialog renderer keeps the window open when an action throws", async () => {
  const wrapper = vueMount(DialogRenderer, {
    props: {
      windowId: "dialog-5",
      definition: {
        kind: "dialog",
        title: "失败动作",
        size: "md",
        schema: {
          fields: [
            {
              kind: "string",
              key: "title",
              label: "标题",
              defaultValue: "保留输入"
            }
          ]
        },
        actions: [
          {
            id: "save",
            label: "保存",
            run: async () => {
              throw new Error("expected failure");
            }
          }
        ]
      }
    }
  });

  await wrapper.get('[data-action-id="save"]').trigger("click");
  assert.equal(wrapper.emitted("resolve"), undefined);
  assert.equal((wrapper.get('input[type="text"]').element as HTMLInputElement).value, "保留输入");
});
