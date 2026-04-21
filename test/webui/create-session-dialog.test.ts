import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("create session window keeps remembered mode and declarative dialog schema", async () => {
  const source = await readFile(
    new URL("../../webui/src/components/sessions/createSessionWindow.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /readStoredCreateSessionModeId/);
  assert.match(source, /writeStoredCreateSessionModeId/);
  assert.match(source, /windows\.open/);
  assert.match(source, /schema:/);
  assert.match(source, /actions:/);
  assert.match(source, /CreateSessionTitleField/);
  assert.match(source, /CreateSessionModeBlock/);
  assert.match(source, /modal:\s*true/);
  assert.doesNotMatch(source, /id:\s*"cancel"/);
});

test("create session title field derives placeholder from current mode", async () => {
  const source = await readFile(
    new URL("../../webui/src/components/sessions/CreateSessionTitleField.vue", import.meta.url),
    "utf8"
  );

  assert.match(source, /resolveCreateSessionTitlePlaceholder/);
  assert.match(source, /props\.values\?\.modeId/);
});
