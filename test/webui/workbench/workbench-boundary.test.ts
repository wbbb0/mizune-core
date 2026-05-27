import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";

async function listSourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory);
  const files: URL[] = [];

  for (const entry of entries) {
    const entryUrl = new URL(`${entry}`, directory);
    const entryStat = await stat(entryUrl);
    if (entryStat.isDirectory()) {
      files.push(...await listSourceFiles(new URL(`${entry}/`, directory)));
    } else if (/\.(ts|vue)$/.test(entry)) {
      files.push(entryUrl);
    }
  }

  return files;
}

test("shared WebUI packages do not import app stores or app adapters", async () => {
  const roots = [
    new URL("../../../vendor/workbench-kit/packages/vue-workbench/src/", import.meta.url),
    new URL("../../../vendor/workbench-kit/packages/vue-resource-editor/src/", import.meta.url),
    new URL("../../../vendor/workbench-kit/packages/vue-file-workspace/src/", import.meta.url)
  ];
  const files = (await Promise.all(roots.map(listSourceFiles))).flat();

  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /@\/stores\//, file.pathname);
    assert.doesNotMatch(source, /@\/api\//, file.pathname);
    assert.doesNotMatch(source, /@\/sections\//, file.pathname);
    assert.doesNotMatch(source, /@\/components\/app\//, file.pathname);
    assert.doesNotMatch(source, /AuthStatusChip|useUiStore/, file.pathname);
  }
});

test("workbench exposes a single public API barrel", async () => {
  const source = await readFile(
    new URL("../../../vendor/workbench-kit/packages/vue-workbench/src/index.ts", import.meta.url),
    "utf8"
  );
  const runtimeSource = await readFile(
    new URL("../../../vendor/workbench-kit/packages/vue-workbench/src/runtime-api.ts", import.meta.url),
    "utf8"
  );
  const primitiveSource = await readFile(
    new URL("../../../vendor/workbench-kit/packages/vue-workbench/src/primitives/index.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /WorkbenchShell/);
  assert.match(primitiveSource, /WorkbenchCard/);
  assert.match(primitiveSource, /WorkbenchDisclosure/);
  assert.match(primitiveSource, /WorkbenchAreaHeader/);
  assert.match(source, /\.\/primitives/);
  assert.match(source, /runtime-api/);
  assert.match(runtimeSource, /useWorkbenchToasts/);
  assert.match(runtimeSource, /windows\/types/);
  assert.match(runtimeSource, /windows\/useWorkbenchWindows/);
  assert.match(runtimeSource, /runtime\/workbenchController/);
});
