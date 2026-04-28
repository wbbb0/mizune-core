import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

  test("session state panel keeps code blocks scrollable and no longer edits titles inline", async () => {
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
    assert.match(source, /WorkbenchDisclosure/);
    assert.match(source, /collapsed-title="派生观察"/);
    assert.match(source, /collapsed-title="最近工具事件"/);
    assert.match(source, /collapsed-title="最近发送记录"/);
    assert.match(source, /WorkbenchCard/);
    assert.match(source, /class="min-w-0 break-all font-mono text-small text-text-secondary"/);
    assert.match(source, /class="mt-1 break-all font-mono text-small text-text-muted"/);
  });
