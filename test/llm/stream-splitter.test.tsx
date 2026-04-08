import assert from "node:assert/strict";
import { splitReadySegments } from "../../src/llm/shared/streamSplitter.ts";

function runCase(name: string, fn: () => void) {
  process.stdout.write(`- ${name} ... `);
  fn();
  process.stdout.write("ok\n");
}

function main() {
  runCase("single newlines flush ready chunks and mark them for double-newline rejoin", () => {
    const result = splitReadySegments("第一段\n第二段");

    assert.deepEqual(result.ready, [
      {
        text: "第一段",
        joinWithDoubleNewline: true
      }
    ]);
    assert.equal(result.rest, "第二段");
  });

  runCase("sentence-based splits do not request double-newline rejoin", () => {
    const result = splitReadySegments("这是一个足够长的第一句。这里是第二句");

    assert.deepEqual(result.ready, [
      {
        text: "这是一个足够长的第一句。",
        joinWithDoubleNewline: false
      }
    ]);
    assert.equal(result.rest, "这里是第二句");
  });

  runCase("fenced markdown blocks stay intact in a single chunk", () => {
    const result = splitReadySegments("先看这个示例\n```ts\nconst value = 1;\nconsole.log(value);\n```\n最后一句");

    assert.deepEqual(result.ready, [
      {
        text: "先看这个示例",
        joinWithDoubleNewline: true
      },
      {
        text: "```ts\nconst value = 1;\nconsole.log(value);\n```",
        joinWithDoubleNewline: true
      }
    ]);
    assert.equal(result.rest, "最后一句");
  });

  runCase("incomplete fenced blocks stay buffered until closed", () => {
    const result = splitReadySegments("```md\n- a\n- b");

    assert.deepEqual(result.ready, []);
    assert.equal(result.rest, "```md\n- a\n- b");
  });

  runCase("markdown list blocks are preserved as one chunk", () => {
    const result = splitReadySegments("- 第一项\n- 第二项\n收尾");

    assert.deepEqual(result.ready, [
      {
        text: "- 第一项\n- 第二项",
        joinWithDoubleNewline: true
      }
    ]);
    assert.equal(result.rest, "收尾");
  });

  runCase("blockquote markdown blocks are preserved as one chunk", () => {
    const result = splitReadySegments("> 第一行\n> 第二行\n结尾");

    assert.deepEqual(result.ready, [
      {
        text: "> 第一行\n> 第二行",
        joinWithDoubleNewline: true
      }
    ]);
    assert.equal(result.rest, "结尾");
  });

  runCase("markdown tables are preserved as one chunk", () => {
    const result = splitReadySegments("| 列1 | 列2 |\n| --- | --- |\n| A | B |\n收尾");

    assert.deepEqual(result.ready, [
      {
        text: "| 列1 | 列2 |\n| --- | --- |\n| A | B |",
        joinWithDoubleNewline: true
      }
    ]);
    assert.equal(result.rest, "收尾");
  });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
