import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("create session dialog keeps remembered mode, schema wiring, and dynamic title placeholder", async () => {
  const [windowSource, titleFieldSource] = await Promise.all([
    readFile(
      new URL("../../webui/src/components/sessions/createSessionWindow.ts", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL("../../webui/src/components/sessions/CreateSessionTitleField.vue", import.meta.url),
      "utf8"
    )
  ]);

  assert.match(windowSource, /readStoredCreateSessionModeId/);
  assert.match(windowSource, /writeStoredCreateSessionModeId/);
  assert.match(windowSource, /windows\.openDialog/);
  assert.match(windowSource, /schema:/);
  assert.match(windowSource, /actions:/);
  assert.match(windowSource, /CreateSessionTitleField/);
  assert.match(windowSource, /CreateSessionModeBlock/);
  assert.match(windowSource, /modal:\s*true/);
  assert.doesNotMatch(windowSource, /id:\s*"cancel"/);

  assert.match(titleFieldSource, /resolveCreateSessionTitlePlaceholder/);
  assert.match(titleFieldSource, /props\.values\?\.modeId/);
});
