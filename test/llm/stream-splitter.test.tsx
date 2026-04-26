import test from "node:test";
import assert from "node:assert/strict";
import { splitReadySegments } from "../../src/llm/shared/streamSplitter.ts";

  test("single newlines stay buffered until a paragraph boundary", () => {
    const result = splitReadySegments("第一段\n第二段");

    assert.deepEqual(result.ready, []);
    assert.equal(result.rest, "第一段\n第二段");
  });

  test("sentence endings stay buffered inside the same paragraph", () => {
    const result = splitReadySegments("这是一个足够长的第一句。这里是第二句");

    assert.deepEqual(result.ready, []);
    assert.equal(result.rest, "这是一个足够长的第一句。这里是第二句");
  });

  test("paragraph boundaries flush complete paragraphs", () => {
    const result = splitReadySegments("这是第一段。里面还有第二句。\n\n这是第二段");

    assert.deepEqual(result.ready, [
      {
        text: "这是第一段。里面还有第二句。",
        joinWithDoubleNewline: true
      }
    ]);
    assert.equal(result.rest, "这是第二段");
  });

  test("paragraphs followed by markdown blocks stay in one segment", () => {
    const result = splitReadySegments("先看这个示例：\n\n```ts\nconst value = 1;\nconsole.log(value);\n```\n\n最后一句");

    assert.deepEqual(result.ready, [
      {
        text: "先看这个示例：\n\n```ts\nconst value = 1;\nconsole.log(value);\n```",
        joinWithDoubleNewline: true
      }
    ]);
    assert.equal(result.rest, "最后一句");
  });

  test("incomplete fenced blocks stay buffered until closed", () => {
    const result = splitReadySegments("```md\n- a\n- b");

    assert.deepEqual(result.ready, []);
    assert.equal(result.rest, "```md\n- a\n- b");
  });

  test("paragraphs followed by list blocks stay in one segment", () => {
    const result = splitReadySegments("一个小标题：\n\n  - 项目a\n  - 项目b\n  - 项目c\n\n收尾");

    assert.deepEqual(result.ready, [
      {
        text: "一个小标题：\n\n  - 项目a\n  - 项目b\n  - 项目c",
        joinWithDoubleNewline: true
      }
    ]);
    assert.equal(result.rest, "收尾");
  });

  test("markdown thematic breaks are skipped during streaming split", () => {
    const result = splitReadySegments("第一段\n\n---\n\n第二段");

    assert.deepEqual(result.ready, [
      {
        text: "第一段",
        joinWithDoubleNewline: true
      }
    ]);
    assert.equal(result.rest, "第二段");
  });

  test("blockquote markdown blocks are preserved as one chunk", () => {
    const result = splitReadySegments("> 第一行\n> 第二行\n结尾");

    assert.deepEqual(result.ready, [
      {
        text: "> 第一行\n> 第二行",
        joinWithDoubleNewline: true
      }
    ]);
    assert.equal(result.rest, "结尾");
  });

  test("markdown tables are preserved as one chunk", () => {
    const result = splitReadySegments("| 列1 | 列2 |\n| --- | --- |\n| A | B |\n收尾");

    assert.deepEqual(result.ready, [
      {
        text: "| 列1 | 列2 |\n| --- | --- |\n| A | B |",
        joinWithDoubleNewline: true
      }
    ]);
    assert.equal(result.rest, "收尾");
  });
