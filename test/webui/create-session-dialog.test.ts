import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("create session dialog uses remembered mode and default-title placeholder", async () => {
    const source = await readFile(
      new URL("../../webui/src/components/sessions/CreateSessionDialog.vue", import.meta.url),
      "utf8"
    );

    assert.match(source, /readStoredCreateSessionModeId\(modeStorage\)/);
    assert.match(source, /writeStoredCreateSessionModeId\(modeStorage, nextModeId\)/);
    assert.match(source, /:placeholder="titlePlaceholder"/);
    assert.match(source, /resolveCreateSessionTitlePlaceholder\(modeId\.value\)/);
  });
}

void main();
