import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("editorState source keeps reference and optional unset modes distinct", async () => {
  const source = await readFile(
    new URL("../../../webui/src/utils/editorState.ts", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /export function canUnsetNodeValue\(input: \{\s+unsetMode: EditorUnsetMode;\s+schemaOptional: boolean;\s+path: PathSegment\[];\s+modelValue: unknown;\s+\}\): boolean \{/s,
    "expected canUnsetNodeValue helper to be exported with explicit unset-mode inputs"
  );
  assert.match(
    source,
    /if \(input\.path\.length === 0 \|\| input\.modelValue === undefined\) \{\s+return false;\s+\}/s,
    "expected canUnsetNodeValue to reject root paths and missing local values"
  );
  assert.match(
    source,
    /if \(input\.unsetMode === "reference"\) \{\s+return true;\s+\}/s,
    "expected reference-backed editors to allow clearing any local field"
  );
  assert.match(
    source,
    /if \(input\.unsetMode === "optional"\) \{\s+return input\.schemaOptional;\s+\}/s,
    "expected optional-only editors to stay gated by schema.optional"
  );
});
