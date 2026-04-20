import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("sessions page moves title actions into the session actions dialog", async () => {
    const source = await readFile(
      new URL("../../../webui/src/pages/SessionsPage.vue", import.meta.url),
      "utf8"
    );

    assert.match(source, /管理标题、切换当前会话模式，或删除该会话/);
    assert.match(source, /onSaveSessionTitle/);
    assert.match(source, /onRegenerateSessionTitle/);
    assert.match(source, /store\.active\.displayLabel \|\| store\.active\.id/);
    assert.match(source, /actionsDialogSupportsTitleEditing/);
    assert.match(source, /标题生成器不可用/);
  });
}

void main();
