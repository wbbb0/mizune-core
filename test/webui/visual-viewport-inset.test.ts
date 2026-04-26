import test from "node:test";
import assert from "node:assert/strict";
import { resolveKeyboardInsetPx } from "../../webui/src/composables/useVisualViewportInset.ts";

test("keyboard inset is measured against target bottom when a target boundary is provided", () => {
  const inset = resolveKeyboardInsetPx({
    baselineViewportHeight: 900,
    viewportHeight: 550,
    viewportOffsetTop: 0,
    targetBottom: 868
  });

  assert.equal(inset, 318);
});

test("keyboard inset falls back to baseline viewport bottom without a target boundary", () => {
  const inset = resolveKeyboardInsetPx({
    baselineViewportHeight: 900,
    viewportHeight: 550,
    viewportOffsetTop: 0,
    targetBottom: null
  });

  assert.equal(inset, 350);
});

test("keyboard inset accounts for visual viewport offset", () => {
  const inset = resolveKeyboardInsetPx({
    baselineViewportHeight: 900,
    viewportHeight: 550,
    viewportOffsetTop: 24,
    targetBottom: 868
  });

  assert.equal(inset, 294);
});
