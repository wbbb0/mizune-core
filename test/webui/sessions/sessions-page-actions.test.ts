import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

  test("sessions section moves title actions into the unified window actions dialog", async () => {
    const source = await readFile(
      new URL("../../../webui/src/composables/sections/useSessionsSection.ts", import.meta.url),
      "utf8"
    );

    assert.match(source, /管理标题、切换当前会话模式，或删除该会话/);
    assert.match(source, /store\.renameSessionTitle/);
    assert.match(source, /store\.regenerateSessionTitle/);
    assert.match(source, /store\.active\?\.displayLabel \|\| store\.active\?\.id/);
    assert.match(source, /await windows\.open/);
    assert.match(source, /modal:\s*true/);
    assert.match(source, /kind:\s*"child-dialog"/);
    assert.match(source, /title:\s*"确认删除会话"/);
    assert.match(source, /parentId:\s*windowId/);
    assert.match(source, /标题生成器不可用/);
  });
