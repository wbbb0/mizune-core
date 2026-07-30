import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("context maintenance UI disables embedding rebuild while the capability is unavailable", async () => {
  const source = await readFile(
    new URL("../../../webui/src/sections/data/ContextItemsControlPanel.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /const embeddingAvailable = computed\(\(\) => status\.value\?\.embedding\.available === true\)/);
  assert.match(source, /:disabled="actionBusy \|\| !embeddingAvailable"/);
});
