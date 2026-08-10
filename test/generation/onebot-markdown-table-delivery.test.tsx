import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  buildOneBotMarkdownTableDelivery,
  splitMarkdownTableBlocks
} from "../../src/app/generation/oneBotMarkdownTableDelivery.ts";

test("splits mixed markdown into text and valid GFM table blocks", () => {
  const blocks = splitMarkdownTableBlocks([
    "说明文字",
    "",
    "| 名称 | 备注 |",
    "| :--- | ---: |",
    "| A\\|B | `x|y` |",
    "",
    "结尾"
  ].join("\n"));

  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { kind: "text", text: "说明文字\n" });
  assert.deepEqual(blocks[1], {
    kind: "table",
    table: {
      headers: ["名称", "备注"],
      alignments: ["left", "right"],
      rows: [["A|B", "x|y"]],
      raw: "| 名称 | 备注 |\n| :--- | ---: |\n| A\\|B | `x|y` |"
    }
  });
  assert.deepEqual(blocks[2], { kind: "text", text: "\n结尾" });
});

test("does not treat fenced or malformed markdown as a table", () => {
  const fenced = [
    "```md",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "```"
  ].join("\n");
  assert.deepEqual(splitMarkdownTableBlocks(fenced), [{ kind: "text", text: fenced }]);

  const malformed = "| A | B |\n| -- | --- |\n| 1 | 2 |";
  assert.deepEqual(splitMarkdownTableBlocks(malformed), [{ kind: "text", text: malformed }]);
});

test("builds readable PNG image segments from markdown tables", async () => {
  const delivery = await buildOneBotMarkdownTableDelivery([
    "| 项目 | 数值 |",
    "| --- | ---: |",
    "| 苹果 | 12 |",
    "| 香蕉 | 8 |"
  ].join("\n"));

  assert.ok(delivery);
  assert.equal(delivery.renderedTableCount, 1);
  assert.deepEqual(delivery.renderErrors, []);
  assert.equal(delivery.segments.length, 1);
  assert.equal(delivery.segments[0]?.type, "image");
  const file = delivery.segments[0]?.data.file;
  assert.equal(typeof file, "string");
  const png = Buffer.from((file as string).slice("base64://".length), "base64");
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, "png");
  assert.ok((metadata.width ?? 0) >= 220);
  assert.ok((metadata.height ?? 0) > 100);
});

test("bounds image dimensions for very wide or multiline model output", async () => {
  const headers = Array.from({ length: 12 }, (_, index) => `很长的第${index + 1}列表头`);
  const longCell = Array.from({ length: 30 }, () => "包含特殊字符 <>& 的很长内容").join("<br>");
  const markdown = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    `| ${headers.map(() => longCell).join(" | ")} |`
  ].join("\n");
  const delivery = await buildOneBotMarkdownTableDelivery(markdown);

  assert.ok(delivery);
  const file = delivery.segments[0]?.data.file;
  const png = Buffer.from((file as string).slice("base64://".length), "base64");
  const metadata = await sharp(png).metadata();
  assert.ok((metadata.width ?? Infinity) <= 2_002);
  assert.ok((metadata.height ?? Infinity) <= 3_602);
});

test("keeps ordinary markdown on the existing text-only path", async () => {
  assert.equal(await buildOneBotMarkdownTableDelivery("**普通文本**\n\n- 项目"), null);
});
