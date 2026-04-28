import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("workbench disclosure renders a single expandable card with scrollable body", async () => {
  const source = await readFile(
    new URL("../../../webui/src/components/workbench/primitives/WorkbenchDisclosure.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /expanded\s*\?\s*'overflow-hidden rounded-lg border border-border-default bg-surface-input'/);
  assert.match(source, /expanded\s*\?\s*'border-0 border-b border-border-default bg-transparent'/);
  assert.match(source, /max-h-\[min\(32rem,60dvh\)\]/);
  assert.match(source, /maxBodyHeightClass/);
  assert.match(source, /overflow-auto/);
  assert.match(source, /bodyClass/);
});
