import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sectionNames = ["Config", "Data", "Sessions", "Settings", "Workspace"] as const;

async function readSectionSource(name: typeof sectionNames[number]) {
  return readFile(
    new URL(`../../../webui/src/composables/sections/use${name}Section.ts`, import.meta.url),
    "utf8"
  );
}

test("shared section state resets from one route-aware lifecycle helper", async () => {
  const sectionSources = await Promise.all(sectionNames.map((name) => readSectionSource(name)));
  const sharedStateSource = await readFile(
    new URL("../../../webui/src/composables/sections/sharedSectionState.ts", import.meta.url),
    "utf8"
  );

  for (const source of sectionSources) {
    assert.match(source, /createSharedSectionState/);
    assert.doesNotMatch(source, /effectScope\(true\)/);
    assert.doesNotMatch(source, /onBeforeRouteLeave/);
  }

  assert.match(sharedStateSource, /effectScope\(true\)/);
  assert.match(sharedStateSource, /useRoute/);
  assert.match(sharedStateSource, /watch\(/);
  assert.match(sharedStateSource, /route\.name \?\? route\.fullPath/);
  assert.match(sharedStateSource, /onBeforeRouteLeave/);
});
