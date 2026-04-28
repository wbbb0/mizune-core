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

test("workbench core does not import app stores or app adapters", async () => {
  const roots = [
    new URL("../../../webui/src/components/workbench/", import.meta.url),
    new URL("../../../webui/src/composables/workbench/", import.meta.url)
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
    new URL("../../../webui/src/components/workbench/index.ts", import.meta.url),
    "utf8"
  );
  const primitiveSource = await readFile(
    new URL("../../../webui/src/components/workbench/primitives/index.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /WorkbenchShell/);
  assert.match(primitiveSource, /WorkbenchCard/);
  assert.match(primitiveSource, /WorkbenchDisclosure/);
  assert.match(primitiveSource, /WorkbenchAreaHeader/);
  assert.match(source, /useWorkbenchToasts/);
  assert.match(source, /\.\/primitives/);
  assert.match(source, /windows\/types/);
  assert.match(source, /windows\/useWorkbenchWindows/);
  assert.match(source, /runtime\/workbenchRuntime/);
});
