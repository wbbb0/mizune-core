import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("sessions store handles draft overlays and session list stream events", async () => {
  const source = await readFile(new URL("../../../webui/src/stores/sessions.ts", import.meta.url), "utf8");

  assert.match(source, /draftAssistantText/);
  assert.match(source, /draftTurnId/);
  assert.match(source, /draft_delta/);
  assert.match(source, /segment_committed/);
  assert.doesNotMatch(source, /streamingText/);
  assert.doesNotMatch(source, /addEventListener\("chunk"/);
  assert.match(source, /openListStream/);
  assert.match(source, /session_upsert/);
  assert.match(source, /session_removed/);
  assert.match(source, /syncSessionDisplayFields/);
  assert.match(source, /sortSessionListItems/);
});
