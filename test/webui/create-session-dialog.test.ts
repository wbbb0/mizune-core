import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

  test("create session dialog uses remembered mode and default-title placeholder", async () => {
    const source = await readFile(
      new URL("../../webui/src/components/sessions/CreateSessionDialog.vue", import.meta.url),
      "utf8"
    );

    assert.match(source, /readStoredCreateSessionModeId\(modeStorage\)/);
    assert.match(source, /writeStoredCreateSessionModeId\(modeStorage, nextModeId\)/);
    assert.match(source, /:placeholder="titlePlaceholder"/);
    assert.match(source, /resolveCreateSessionTitlePlaceholder\(modeId\.value\)/);
  });
