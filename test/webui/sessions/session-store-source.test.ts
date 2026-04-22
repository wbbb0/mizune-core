import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("sessions store uses draft overlay events instead of chunk streaming text", async () => {
  const source = await readFile(new URL("../../../webui/src/stores/sessions.ts", import.meta.url), "utf8");

  assert.match(source, /draftAssistantText/);
  assert.match(source, /draftTurnId/);
  assert.match(source, /draft_delta/);
  assert.match(source, /segment_committed/);
  assert.doesNotMatch(source, /streamingText/);
  assert.doesNotMatch(source, /addEventListener\("chunk"/);
});
