import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function branchSlice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `expected to find branch start marker: ${startMarker}`);
  assert.notEqual(end, -1, `expected to find branch end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("SchemaNode source keeps label priority and hover metadata wiring", async () => {
  const source = await readFile(
    new URL("../../../webui/src/components/editor/SchemaNode.vue", import.meta.url),
    "utf8"
  );

  const labelPriorityParts = [
    "props.headerLabel ??",
    "props.node.schema.title ??",
    "props.fieldKey ?? \"\""
  ];
  let searchFrom = 0;
  for (const part of labelPriorityParts) {
    const index = source.indexOf(part, searchFrom);
    assert.notEqual(index, -1, `expected to find ${part} in label priority chain`);
    searchFrom = index + part.length;
  }

  assert.match(
    source,
    /<span v-else-if="label" class="min-w-0 flex items-center gap-1 truncate text-small leading-\[1\.3\]" :title="node\.schema\.description \|\| label">/,
    "expected field branch to keep hover bound to node.schema.description"
  );
  const groupBranch = branchSlice(
    source,
    "<div v-else-if=\"node.kind === 'group'\"",
    "<div v-else-if=\"node.kind === 'array'\""
  );
  assert.match(
    groupBranch,
    /<span v-else :class="labelClasses" :title="node\.schema\.description">/,
    "expected group branch to keep hover bound to node.schema.description"
  );

  const arrayBranch = branchSlice(
    source,
    "<div v-else-if=\"node.kind === 'array'\"",
    "<div v-else-if=\"node.kind === 'record'\""
  );
  assert.match(
    arrayBranch,
    /<span v-else :class="labelClasses" :title="node\.schema\.description">/,
    "expected array branch header to expose node.schema.description in hover"
  );

  const recordBranch = branchSlice(
    source,
    "<div v-else-if=\"node.kind === 'record'\"",
    "<div v-else-if=\"node.kind === 'union'\""
  );
  assert.match(
    recordBranch,
    /<span v-else :class="labelClasses" :title="node\.schema\.description">/,
    "expected record branch header to expose node.schema.description in hover"
  );
});
