import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("main stylesheet defines a danger button variant for destructive actions", async () => {
  const source = await readFile(
    new URL("../../webui/src/style/main.css", import.meta.url),
    "utf8"
  );

  assert.match(source, /\.btn-danger\s*\{/);
  assert.match(source, /\.btn-danger:hover\s*\{/);
});
