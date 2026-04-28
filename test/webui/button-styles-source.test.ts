import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("workbench stylesheet defines a danger button variant for destructive actions", async () => {
  const source = await readFile(
    new URL("../../webui/src/style/workbench.css", import.meta.url),
    "utf8"
  );

  assert.match(source, /\.btn-danger\s*\{/);
  assert.match(source, /\.btn-danger:hover\s*\{/);
});
