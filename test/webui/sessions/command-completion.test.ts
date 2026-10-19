import test from "node:test";
import assert from "node:assert/strict";
import { getDirectCommandCompletions, parseDirectCommand } from "../../../src/app/messaging/directCommands.ts";
import { applyCommandCompletion, resolveCommandCompletion } from "../../../webui/src/components/sessions/commandCompletion.ts";

const commands = getDirectCommandCompletions();
const resolve = (text: string, caret = text.length) => resolveCommandCompletion(text, caret, commands, ["stk_a", "stk_b"]);

test("catalog command names and enum combinations match executable grammar", () => {
  for (const command of commands) {
    const parameters = command.parameters;
    const examples = parameters.length ? (parameters[0]?.values ?? ["example"]) : [""];
    for (const first of examples) {
      const args = parameters.map((param, index) => {
        if (param.when && first !== param.when.value) return "";
        if (index === 0 && param.values) return first;
        if (param.separator) return `old ${param.separator}`;
        if (param.name === "数量" || param.name === "保留条数" || param.name === "userId") return "1";
        return "example";
      }).filter(Boolean).join(" ");
      assert.ok(parseDirectCommand(`.${command.name} ${args}`), command.name + " " + args);
    }
  }
});

test("only command drafts complete; both prefixes and uppercase are supported", () => {
  assert.deepEqual(resolve("。De")?.values, ["debug"]);
  assert.ok(resolve(".")?.values.includes("sticker"));
  for (const draft of ["你好 .deb", "普通文本", ".debug\non", ".unknown "]) assert.equal(resolve(draft), null);
  assert.deepEqual(resolve(".help")?.values, []);
  assert.deepEqual(resolve(".debug on")?.values, []); // 不把 on 意外补成 once
  assert.deepEqual(resolve(".setup ")?.values, ["persona", "rp", "scenario"]);
  assert.deepEqual(resolve(".sticker lock stk_")?.values, ["stk_a", "stk_b"]);
});

test("free parameters are hints, conditional and multiword arguments remain intact", () => {
  assert.equal(resolve(".remember 任意 多个 词")?.hint, "<内容>");
  assert.equal(resolve(".debug once ")?.hint, "<文本>");
  assert.equal(resolve(".debug off "), null);
  assert.equal(resolve(".replace-memory 旧 文本 ")?.hint, "<旧文本> => <新内容>");
  assert.equal(resolve(".replace-memory 旧 文本 => 新 内容")?.hint, "<新内容>");
  assert.deepEqual(resolve(".compact ")?.values, []);
  assert.equal(resolve(".compact ")?.hint, "<保留条数>");
});

test("completion replaces the current token and preserves following text", () => {
  const draft = ".debug onn 后面的内容";
  const completion = resolve(draft, 8)!;
  assert.deepEqual(applyCommandCompletion(draft, completion, "once", commands), { text: ".debug once 后面的内容", caret: 11 });
  assert.deepEqual(applyCommandCompletion("。st", resolve("。st")!, "sticker", commands), { text: "。sticker ", caret: 9 });
  assert.deepEqual(applyCommandCompletion(".he", resolve(".he")!, "help", commands), { text: ".help", caret: 5 });
});
