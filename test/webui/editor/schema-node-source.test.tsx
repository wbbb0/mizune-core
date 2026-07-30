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
    new URL("../../../vendor/workbench-kit/packages/vue-resource-editor/src/components/SchemaNode.vue", import.meta.url),
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
    /<span v-else-if="label" class="min-w-0 flex items-center gap-1 truncate text-small leading-\[1\.3\]" :title="description \|\| label">/,
    "expected field branch to keep hover bound to field-aware description"
  );
  const groupBranch = branchSlice(
    source,
    "<div v-else-if=\"node.kind === 'group'\"",
    "<div v-else-if=\"node.kind === 'array'\""
  );
  assert.match(
    groupBranch,
    /<span v-else :class="labelClasses" :title="description">/,
    "expected group branch to keep hover bound to field-aware description"
  );

  const arrayBranch = branchSlice(
    source,
    "<div v-else-if=\"node.kind === 'array'\"",
    "<div v-else-if=\"node.kind === 'record'\""
  );
  assert.match(
    arrayBranch,
    /<span v-else :class="labelClasses" :title="description">/,
    "expected array branch header to expose field-aware description in hover"
  );

  const recordBranch = branchSlice(
    source,
    "<div v-else-if=\"node.kind === 'record'\"",
    "<div v-else-if=\"node.kind === 'union'\""
  );
  assert.match(
    recordBranch,
    /<span v-else :class="labelClasses" :title="description">/,
    "expected record branch header to expose field-aware description in hover"
  );
});

test("SchemaNode source renders object children through field metadata wrappers", async () => {
  const source = await readFile(
    new URL("../../../vendor/workbench-kit/packages/vue-resource-editor/src/components/SchemaNode.vue", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /:node="child\.node"/,
    "expected object child nodes to use the field wrapper's node"
  );
  assert.match(
    source,
    /:header-label="child\.field\.title"/,
    "expected object child labels to prefer field-level titles"
  );
  assert.match(
    source,
    /:header-description="child\.field\.description"/,
    "expected object child hover text to prefer field-level descriptions"
  );
});

test("SchemaNode source propagates schema default values through recursive branches", async () => {
  const source = await readFile(
    new URL("../../../vendor/workbench-kit/packages/vue-resource-editor/src/components/SchemaNode.vue", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /defaultValue\?: unknown;/,
    "expected SchemaNode to accept a schema default value"
  );
  assert.match(
    source,
    /function childDefaultValue\(key: string\): unknown \{\s+return asObj\(props\.defaultValue\)\[key\];\s+\}/s,
    "expected object children to receive their matching schema default value"
  );
  assert.match(
    source,
    /function defaultArrayItem\(index: number\): unknown \{\s+return defaultItems\.value\[index\];\s+\}/s,
    "expected array items to receive their matching schema default value"
  );
  assert.match(
    source,
    /:default-value="defaultRecordValue\(key\)"/,
    "expected record entries to pass through matching schema default values"
  );
});

test("SchemaNode keeps an explicitly emptied array instead of restoring inherited items", async () => {
  const source = await readFile(
    new URL("../../../vendor/workbench-kit/packages/vue-resource-editor/src/components/SchemaNode.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /function removeArrayItem\(index: number\)[\s\S]*emit\("update:modelValue", next\);/);
  assert.doesNotMatch(source, /next\.length > 0 \? next : undefined/);
});

test("SchemaField does not offer an invalid empty choice for required dynamic references", async () => {
  const source = await readFile(
    new URL("../../../vendor/workbench-kit/packages/vue-resource-editor/src/components/SchemaField.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /<option v-if="!schema\.optional && !currentStringValue\(\)" value="" disabled>请选择<\/option>/);
  assert.match(source, /<option v-if="schema\.optional" value="">—<\/option>/);
  assert.match(source, /function onDynamicRefChange[\s\S]*value \|\| undefined/);
  assert.match(source, /@change="onDynamicRefChange"/);
});
