import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

  test("session list item exposes full label on hover", async () => {
    const source = await readFile(
      new URL("../../../webui/src/components/sessions/SessionListItem.vue", import.meta.url),
      "utf8"
    );

    assert.match(source, /:title="display\.label"/);
    assert.match(source, /overflow-hidden text-ellipsis whitespace-nowrap/);
  });
