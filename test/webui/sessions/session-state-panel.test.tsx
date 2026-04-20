import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function runCase(name: string, fn: () => Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("session state panel keeps code blocks scrollable and no longer edits titles inline", async () => {
    const source = await readFile(
      new URL("../../../webui/src/components/sessions/SessionStatePanel.vue", import.meta.url),
      "utf8"
    );

    assert.match(source, /标题/);
    assert.doesNotMatch(source, /保存标题/);
    assert.doesNotMatch(source, /重新生成标题/);
    assert.match(source, /主体类型/);
    assert.match(source, /主体 ID/);
    assert.match(source, /<pre[^>]*overflow-auto[^>]*>{{ detail\?\.session\.historySummary \|\| "暂无摘要" }}/);
    assert.match(source, /<pre[^>]*overflow-auto[^>]*>{{ formatJson\(detail\?\.session\.debugControl/);
    assert.match(source, /<pre[^>]*overflow-auto[^>]*>{{ formatJson\(detail\?\.session\.lastLlmUsage/);
  });
}

void main();
