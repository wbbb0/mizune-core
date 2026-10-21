/// <reference lib="dom" />
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// @ts-expect-error jsdom vendor path has no bundled declaration file
import { JSDOM } from "../../../webui/node_modules/jsdom/lib/api.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const key of ["window", "document", "navigator", "HTMLElement", "SVGElement", "Element", "Node", "Document", "ShadowRoot"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
const require = createRequire(import.meta.url);
const compiler = require("../../../webui/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js");
const ts = require("../../../webui/node_modules/typescript/lib/typescript.js");
const vueUrl = new URL("../../../webui/node_modules/vue/index.mjs", import.meta.url).href;
const source = readFileSync(new URL("../../../webui/src/sections/skills/SkillContentEditor.vue", import.meta.url), "utf8");
const { descriptor } = compiler.parse(source);
const compiled = compiler.compileScript(descriptor, { id: "skill-editor", inlineTemplate: true }).content;
const code = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll('from "vue"', `from "${vueUrl}"`);

test("skill editor keeps policy layers independent, supports toolset multi-selection and validates reference paths", async () => {
  const utilsUrl = new URL("../../../webui/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs", import.meta.url).href;
  const { mount } = await import(utilsUrl) as typeof import("../../../webui/node_modules/@vue/test-utils/dist/index.js");
  const { reactive } = await import("vue");
  const { default: component } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`);
  const draft = reactive({ document: "---\nname: 示例\n---", resources: {} as Record<string, string>, toolsetIds: [] as string[], userPolicy: "auto", modelEditable: true, modelPaused: true, modelPauseReason: "暂停原因", changeReason: "" });
  const wrapper = mount(component, { props: { draft, disabled: false, toolsets: [{ id: "web", title: "网页", description: "" }, { id: "files", title: "文件", description: "" }] } });
  try {
    await wrapper.find("select").setValue("disabled");
    assert.equal(draft.userPolicy, "disabled");
    assert.equal(draft.modelPaused, true);
    assert.equal(draft.modelPauseReason, "暂停原因");
    const boxes = wrapper.findAll('input[type="checkbox"]');
    await boxes[2]!.setValue(true);
    await boxes[3]!.setValue(true);
    assert.deepEqual([...draft.toolsetIds], ["web", "files"]);
    const resource = wrapper.find('input[aria-label="资源路径"]');
    const add = () => wrapper.findAll("button").find((button) => button.text() === "添加资源")!.trigger("click");
    await resource.setValue("references/../secret.md"); await add();
    assert.deepEqual(Object.keys(draft.resources), []);
    assert.match(wrapper.get('[role="alert"]').text(), /相对文件路径/);
    await resource.setValue("references/example.md"); await add();
    await wrapper.find('textarea[aria-label="references/example.md"]').setValue("参考内容");
    assert.equal(draft.resources["references/example.md"], "参考内容");
    await wrapper.findAll("button").find((button) => button.text() === "移除资源")!.trigger("click");
    assert.deepEqual(Object.keys(draft.resources), []);
    await wrapper.setProps({ disabled: true });
    assert.equal(wrapper.get("fieldset").attributes("disabled"), "");
  } finally { wrapper.unmount(); }
});
