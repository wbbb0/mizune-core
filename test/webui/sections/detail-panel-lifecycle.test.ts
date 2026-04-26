import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readSectionSource(name: "Config" | "Data") {
  return readFile(
    new URL(`../../../webui/src/composables/sections/use${name}Section.ts`, import.meta.url),
    "utf8"
  );
}

test("config and data shared section watchers survive route component unmounts", async () => {
  const configSource = await readSectionSource("Config");
  const dataSource = await readSectionSource("Data");

  for (const source of [configSource, dataSource]) {
    assert.match(source, /effectScope/);
    assert.match(source, /effectScope\(true\)/);
    assert.match(source, /\.run\(\(\) => \{/);
  }
});
