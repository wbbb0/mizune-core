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
    assert.match(source, /{{ display\.label }}/);
    assert.match(source, /{{ relativeTime }}/);
    assert.doesNotMatch(source, /items-baseline gap-1\.5[\s\S]*{{ relativeTime }}/);
  });
