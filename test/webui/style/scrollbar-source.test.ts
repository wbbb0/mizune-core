import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("webui uses one thin scrollbar style globally", async () => {
  const source = await readFile(
    new URL("../../../webui/src/style/workbench.css", import.meta.url),
    "utf8"
  );

  assert.match(source, /scrollbar-width:\s*thin/);
  assert.match(source, /scrollbar-color:\s*var\(--scrollbar-thumb\) var\(--scrollbar-bg\)/);
  assert.match(source, /::\-webkit-scrollbar\s*{\s*width:\s*4px;\s*height:\s*4px;/);
  assert.doesNotMatch(source, /::\-webkit-scrollbar\s*{\s*width:\s*8px/);
});
