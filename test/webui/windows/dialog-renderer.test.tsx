/// <reference lib="dom" />

import test from "node:test";
import { llmCatalogFileSchema } from "#config/configModel.ts";
import { buildUiTree } from "#data/schema/ui.ts";
import { resolveModelAddSchema } from "../../../webui/src/sections/config/modelAddSchema.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createTempDir } from "../../helpers/temp-paths.ts";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
// @ts-expect-error jsdom vendor path has no bundled declaration file in this workspace layout
import { JSDOM } from "../../../webui/node_modules/jsdom/lib/api.js";
import type { WorkbenchDialogField, WorkbenchWindowDefinition } from "@workbench-kit/vue";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const compilerSfc = require(`${ROOT}/webui/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js`);
const typescript = require(`${ROOT}/webui/node_modules/typescript/lib/typescript.js`);
const VUE_RUNTIME_URL = new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href;
const VUE_TEST_UTILS_URL = new URL("../../../webui/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs", import.meta.url).href;
const DIALOG_RENDERER_PATH = `${ROOT}/vendor/workbench-kit/packages/vue-workbench/src/windows/DialogRenderer.vue`;
const DIALOG_FIELD_RENDERER_PATH = `${ROOT}/vendor/workbench-kit/packages/vue-workbench/src/windows/DialogFieldRenderer.vue`;
const TYPES_URL = new URL("../../../vendor/workbench-kit/packages/vue-workbench/src/windows/types.ts", import.meta.url).href;

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

const dialogFieldRendererUrl = compileVueModule(DIALOG_FIELD_RENDERER_PATH, {
  vue: vueStubUrl
});

const dialogRendererUrl = compileVueModule(DIALOG_RENDERER_PATH, {
  vue: vueStubUrl,
  "./DialogFieldRenderer.vue": dialogFieldRendererUrl,
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

test("dialog renderer keeps the content area scrollable under constrained window height", async () => {
  const wrapper = vueMount(DialogRenderer, {
    props: {
      windowId: "dialog-scroll",
      definition: {
        kind: "dialog",
        title: "滚动内容",
        size: "md",
        blocks: [
          { kind: "text", content: "长内容" }
        ],
        actions: []
      }
    }
  });

  assert.match(wrapper.classes().join(" "), /min-h-0/);
  const scrollContainer = wrapper.get(".scrollbar-thin");
  assert.match(scrollContainer.classes().join(" "), /overflow-y-auto/);
  assert.match(scrollContainer.classes().join(" "), /min-h-0/);
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

function realSchemaNodeModule() {
  const resourceRoot = new URL('../../../vendor/workbench-kit/packages/vue-resource-editor/src/', import.meta.url);
  const resourceFile = (path: string) => new URL(path, resourceRoot).href;
  const iconsUrl = createDataModule(`import { h } from '${VUE_RUNTIME_URL}'; const Icon = { render: () => h('svg') }; export const ChevronRight = Icon, ChevronDown = Icon, Folder = Icon, FolderOpen = Icon, Plus = Icon, Trash2 = Icon, ArrowUp = Icon, ArrowDown = Icon, Pencil = Icon, Check = Icon, Undo2 = Icon, Copy = Icon, Play = Icon;`);
  const field = compileVueModule(`${ROOT}/vendor/workbench-kit/packages/vue-resource-editor/src/components/SchemaField.vue`, {
    vue: vueStubUrl, '../resourceEditorClient': resourceFile('resourceEditorClient.ts')
  });
  const picker = compileVueModule(`${ROOT}/vendor/workbench-kit/packages/vue-resource-editor/src/components/GroupedOptionPicker.vue`, {
    vue: vueStubUrl, '../editorState.js': resourceFile('editorState.ts'), '../resourceEditorClient.js': resourceFile('resourceEditorClient.ts')
  });
  const tree = compileVueModule(`${ROOT}/vendor/workbench-kit/packages/vue-workbench/src/primitives/TreeNodeShell.vue`, {
    vue: vueStubUrl, 'lucide-vue-next': iconsUrl,
    '../runtime/workbenchAreaContext.js': new URL('../../../vendor/workbench-kit/packages/vue-workbench/src/runtime/workbenchAreaContext.ts', import.meta.url).href
  });
  const workbench = createDataModule(`export { default as TreeNodeShell } from ${JSON.stringify(tree)};`);
  const schemaNode = compileVueModule(`${ROOT}/vendor/workbench-kit/packages/vue-resource-editor/src/components/SchemaNode.vue`, {
    vue: vueStubUrl, 'lucide-vue-next': iconsUrl, '@workbench-kit/vue-workbench': workbench,
    '../schemaVariant': resourceFile('schemaVariant.ts'), '../editorState': resourceFile('editorState.ts'),
    './SchemaField.vue': field, './GroupedOptionPicker.vue': picker
  });
  // 避免把较大的递归组件重复嵌入外层 data URL，实际模块保持普通文件导入。
  const file = `${createTempDir('model-add-schema-renderer')}/SchemaNode.mjs`;
  writeFileSync(file, decodeURIComponent(schemaNode.slice(schemaNode.indexOf(',') + 1)));
  return pathToFileURL(file).href;
}

async function loadModelAdd(models: unknown[], actualSchema = false) {
  const apiUrl = createDataModule(`export async function listProviderModels() { return ${JSON.stringify({ kind: "ok", warnings: [], models })}; }`);
  const widgetsUrl = createDataModule(`
    import { h } from '${VUE_RUNTIME_URL}';
    const Box = { setup: (_, { slots }) => () => h('div', slots.default?.()) };
    export const WorkbenchCard = Box, WorkbenchEmptyState = Box, WorkbenchSelect = Box,
      WorkbenchTabStrip = Box, WorkbenchTextInput = Box, WorkbenchDataTable = Box;
    export const WorkbenchButton = { props: ['label','disabled'], emits: ['click'], setup: (props, {emit}) => () => h('button', {disabled: props.disabled, onClick: () => emit('click')}, props.label) };
    export const WorkbenchFormField = { props: ['label'], setup: (props, { slots }) => () => h('label', [props.label, slots.default?.()]) };
    export const WorkbenchMultiSelect = { props: ['options'], setup: props => () => h('div', { 'data-model-options': JSON.stringify(props.options) }) };
    const labels = node => [node.schema.title, ...Object.values(node.children ?? {}).map(child => labels(child.node))].flat().filter(Boolean);
    ${actualSchema ? `export { default as SchemaNode } from '${realSchemaNodeModule()}';` : `export const SchemaNode = { props: ['node'], setup: props => () => h('div', {'data-profile-schema': 'true'}, labels(props.node).join(' ')) };`}
    export const ResponsiveSplitPane = { setup: (_, { slots }) => () => h('div', [slots.primary?.({compact: false}), slots.secondary?.({compact: false})]) };
  `);
  const iconsUrl = createDataModule(`export const AlertCircle = {}, Check = {}, DownloadCloud = {}, RefreshCw = {}, Search = {};`);
  const modelUrl = compileVueModule(`${ROOT}/webui/src/sections/config/LlmModelAddWindow.vue`, {
    vue: vueStubUrl, '@workbench-kit/vue': widgetsUrl, '@/api/editor': apiUrl, 'lucide-vue-next': iconsUrl,
    './modelAddSchema': new URL('../../../webui/src/sections/config/modelAddSchema.ts', import.meta.url).href,
    '../../../../src/llm/provider/modelDiscoveryMetadata.ts': new URL('../../../src/llm/provider/modelDiscoveryMetadata.ts', import.meta.url).href
  });
  return (await import(modelUrl)).default;
}

function modelFormProps(type: string) {
  return {
    provider: { type, models: {} },
    modelSchema: resolveModelAddSchema(JSON.parse(JSON.stringify(buildUiTree(llmCatalogFileSchema))), type)!,
    editorFeatures: {}, submitEntry: async (_entry: unknown) => true, closeWindow: () => {}
  };
}

test("模型组件状态在窗口快照刷新后保留，向量模型提交后窗口保持打开", async () => {
  const profile = { embedding: { limits: { maxInputTokens: 32768 } } };
  const ModelAdd = await loadModelAdd([{
    upstreamModel: 'qwen/qwen3-embedding-8b', alias: 'qwen_qwen3_embedding_8b', exists: false,
    profile, suggested: profile, sources: ['embedding']
  }]);
  const calls: unknown[] = [];
  const props = modelFormProps('openai_compatible');
  props.submitEntry = async entry => { calls.push(entry); return true; };
  const definition: WorkbenchWindowDefinition = {
    kind: 'dialog', title: '添加模型', size: 'xl', footer: 'hidden',
    blocks: [{ kind: 'component', component: ModelAdd, props }]
  };
  const wrapper = vueMount(DialogRenderer, { props: { windowId: 'model-add', definition } });
  await vueTestUtils.flushPromises();
  const button = wrapper.findAll('button').find((button: any) => button.text() === '添加模型')!;
  assert.equal((button.element as HTMLButtonElement).disabled, false, "before refresh");
  await wrapper.setProps({ definition: { ...definition } });
  assert.equal((button.element as HTMLButtonElement).disabled, false, "after refresh");
  await button.trigger('click');
  await vueTestUtils.flushPromises();
  assert.deepEqual(calls, [{ upstreamModel: 'qwen/qwen3-embedding-8b', alias: 'qwen_qwen3_embedding_8b', profile }]);
  assert.equal(wrapper.emitted('resolve'), undefined);
  wrapper.unmount();
});

test("新增模型按供应商 Schema 展示原生用途及完整转写参数", async () => {
  const ModelAdd = await loadModelAdd([{
    upstreamModel: 'transcriber', alias: 'transcriber', exists: false,
    profile: { transcription: {} }, suggested: {}, sources: ['test']
  }]);
  for (const type of ['openai', 'google']) {
    const wrapper = vueMount(ModelAdd, { props: modelFormProps(type) });
    await vueTestUtils.flushPromises();
    const options = JSON.parse(wrapper.get('[data-model-options]').attributes('data-model-options'));
    assert.equal(options.some((item: { value: string }) => item.value === 'speech'), type === 'openai');
    assert.equal(options.some((item: { value: string }) => item.value === 'decision'), type === 'openai');
    assert.equal(wrapper.text().includes('可关闭思考'), type !== 'openai');
    assert.equal(wrapper.text().includes('支持原生视频输入'), type === 'google');
    assert.ok(wrapper.text().includes('音频语言代码'));
    assert.ok(wrapper.text().includes('转写提示'));
    wrapper.unmount();
  }
});


test("新增模型通过真实 SchemaNode 编辑额外 JSON 参数并提交，窗口不关闭", async () => {
  const ModelAdd = await loadModelAdd([{
    upstreamModel: 'synthetic-chat', alias: 'synthetic_chat', exists: false,
    profile: { chat: {} }, suggested: { chat: {} }, sources: ['synthetic']
  }], true);
  const calls: any[] = [];
  const props = modelFormProps('openai_compatible');
  props.submitEntry = async entry => { calls.push(entry); return true; };
  const wrapper = vueMount(DialogRenderer, { props: { windowId: 'model-extra', definition: {
    kind: 'dialog', title: '添加模型', size: 'xl', footer: 'hidden',
    blocks: [{ kind: 'component', component: ModelAdd, props }]
  } } });
  await vueTestUtils.flushPromises();
  for (const label of ['聊天', '生成参数']) {
    const toggle = wrapper.findAll('.tree-shell-header button').find((button: any) => button.text() === label);
    assert.ok(toggle, `missing ${label} group`);
    await toggle.trigger('click');
  }
  const row = wrapper.findAll('.editor-field-row').find((row: any) => row.text().includes('额外请求参数（高级）'));
  assert.ok(row, 'extra JSON field');
  const extra = { provider: { order: ['synthetic'] }, enable_search: false, limit: 0 };
  await row.get('textarea').setValue(JSON.stringify(extra));
  const submit = wrapper.findAll('button').find((button: any) => button.text() === '添加模型')!;
  await submit.trigger('click');
  await vueTestUtils.flushPromises();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].profile.chat.defaults.extra, extra);
  assert.equal(wrapper.emitted('resolve'), undefined);
  wrapper.unmount();
});
