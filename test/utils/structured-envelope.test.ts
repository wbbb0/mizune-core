import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatStructuredEnvelope,
  sanitizeEnvelopeText
} from "../../src/utils/structuredEnvelope.ts";

test("formatStructuredEnvelope renders a multiline structured block", () => {
  assert.equal(
    formatStructuredEnvelope({
      title: "内容安全",
      fields: [
        { label: "类型", value: "图片" },
        { label: "状态", value: "已屏蔽" }
      ]
    }),
    "⟦内容安全\n类型: 图片\n状态: 已屏蔽\n⟧"
  );
});

test("formatStructuredEnvelope omits empty values but keeps false and zero", () => {
  const rendered = formatStructuredEnvelope({
    title: "测试",
    fields: [
      { label: "空", value: "" },
      { label: "null", value: null },
      { label: "undefined", value: undefined },
      { label: "数字", value: 0 },
      { label: "布尔", value: false }
    ]
  });

  assert.doesNotMatch(rendered, /空:/);
  assert.doesNotMatch(rendered, /null:/);
  assert.doesNotMatch(rendered, /undefined:/);
  assert.match(rendered, /数字: 0/);
  assert.match(rendered, /布尔: false/);
});

test("formatStructuredEnvelope escapes nested envelope delimiters and folds whitespace", () => {
  assert.equal(
    sanitizeEnvelopeText("  A\n⟦B⟧\tC  "),
    "A ［B］ C"
  );
});

test("formatStructuredEnvelope rejects empty title and labels", () => {
  assert.throws(
    () => formatStructuredEnvelope({ title: " ", fields: [] }),
    /title must not be empty/
  );
  assert.throws(
    () => formatStructuredEnvelope({ title: "测试", fields: [{ label: "\n", value: "x" }] }),
    /field label must not be empty/
  );
});
