import test from "node:test";
import assert from "node:assert/strict";
import { resolveKeyboardInsetPx } from "../../webui/src/composables/useVisualViewportInset.ts";

test("keyboard inset resolves against target, fallback baseline, and visual viewport offset", () => {
  const cases = [
    {
      name: "target boundary",
      targetBottom: 868,
      viewportOffsetTop: 0,
      expected: 318
    },
    {
      name: "baseline fallback",
      targetBottom: null,
      viewportOffsetTop: 0,
      expected: 350
    },
    {
      name: "viewport offset",
      targetBottom: 868,
      viewportOffsetTop: 24,
      expected: 294
    }
  ];

  for (const item of cases) {
    assert.equal(
      resolveKeyboardInsetPx({
        baselineViewportHeight: 900,
        viewportHeight: 550,
        viewportOffsetTop: item.viewportOffsetTop,
        targetBottom: item.targetBottom
      }),
      item.expected,
      item.name
    );
  }
});
