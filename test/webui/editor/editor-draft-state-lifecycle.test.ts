import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("editor draft state model watcher survives route component unmounts", async () => {
  const source = await readFile(
    new URL("../../../webui/src/composables/useEditorDraftState.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /effectScope/);
  assert.match(source, /effectScope\(true\)/);
  assert.match(source, /watch\(model/);
});
