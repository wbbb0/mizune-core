import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("session list item exposes full label on hover", async () => {
    const source = await readFile(
      new URL("../../../webui/src/components/sessions/SessionListItem.vue", import.meta.url),
      "utf8"
    );

    assert.match(source, /:title="display\.label"/);
    assert.match(source, /overflow-hidden text-ellipsis whitespace-nowrap/);
  });
}

void main();
