import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("workbench windows expose generic resource context without session-specific framework code", async () => {
  const [typesSource, managerSource, sessionsContextSource, chatPanelSource] = await Promise.all([
    readFile(new URL("../../../webui/src/components/workbench/windows/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../webui/src/components/workbench/windows/windowManager.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../webui/src/components/sessions/sessionWindowContext.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../webui/src/components/sessions/ChatPanel.vue", import.meta.url), "utf8")
  ]);

  assert.match(typesSource, /export type WorkbenchWindowContext/);
  assert.match(typesSource, /context\?: WorkbenchWindowContext/);
  assert.match(managerSource, /closeByContext/);
  assert.doesNotMatch(typesSource, /sessionId|Session/);
  assert.doesNotMatch(managerSource, /sessionId|Session/);
  assert.match(sessionsContextSource, /kind:\s*"session"/);
  assert.match(chatPanelSource, /context:\s*createSessionWindowContext\(session\.value\.id\)/);
});
