import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("chat panel uses backstage tab without transcript badge or inline delete button", async () => {
    const source = await readFile(new URL("../../../webui/src/components/sessions/ChatPanel.vue", import.meta.url), "utf8");

    assert.match(source, />后台</);
    assert.doesNotMatch(source, /后台记录/);
    assert.doesNotMatch(source, /session\?\.transcriptCount/);
    assert.doesNotMatch(source, /Trash2/);
  });
}

void main();
