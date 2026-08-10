import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

  test("session state panel keeps code blocks scrollable and no longer edits titles inline", async () => {
    const source = await readFile(
      new URL("../../../webui/src/components/sessions/SessionStatePanel.vue", import.meta.url),
      "utf8"
    );
    const pacingControl = await readFile(
      new URL("../../../webui/src/components/sessions/SessionPacingControl.vue", import.meta.url),
      "utf8"
    );

    assert.match(source, /标题/);
    assert.doesNotMatch(source, /保存标题/);
    assert.doesNotMatch(source, /重新生成标题/);
    assert.match(source, /主体类型/);
    assert.match(source, /主体 ID/);
    assert.match(source, /<SessionPacingControl/);
    assert.match(pacingControl, /collapsed-title="会话回复节奏"/);
    assert.match(pacingControl, /用户消息聚合等待/);
    assert.match(pacingControl, /全局自适应/);
    assert.match(pacingControl, /立即处理/);
    assert.match(pacingControl, /固定等待秒数/);
    assert.match(pacingControl, /OneBot 回复模拟输入延迟/);
    assert.match(pacingControl, /sessionsApi\.updatePacing/);
    assert.match(source, /<pre[^>]*overflow-auto[^>]*>{{ detail\?\.session\.historySummary \|\| "暂无摘要" }}/);
    assert.doesNotMatch(source, /function formatJson/);
    assert.doesNotMatch(source, /formatJson\(detail\?\.session\.debugControl/);
    assert.doesNotMatch(source, /formatJson\(detail\?\.session\.lastLlmUsage/);
    assert.match(source, /调试控制/);
    assert.match(source, /debugControlRows/);
    assert.match(source, /最近 LLM 用量/);
    assert.match(source, /lastLlmUsageRows/);
    assert.match(source, /本轮累计输入 tokens/);
    assert.match(source, /本轮累计输出 tokens/);
    assert.match(source, /本轮累计总 tokens/);
    assert.match(source, /本轮请求数/);
    assert.match(source, /Token 指标为本轮所有模型请求的累计值，不代表单次上下文长度。/);
    assert.match(source, /lastRequestUsageRows/);
    assert.match(source, /最近一次请求（Provider 返回）/);
    assert.match(source, /暂无单次请求用量记录/);
    assert.match(source, /暂无 LLM 用量记录/);
    assert.match(source, /collapsed-title="任务跟踪"/);
    assert.match(source, /taskTrackerSummary/);
    assert.match(source, /最近 Evidence/);
    assert.match(source, /WorkbenchDisclosure/);
    assert.match(source, /collapsed-title="派生观察"/);
    assert.doesNotMatch(source, /collapsed-title="最近工具事件"/);
    assert.match(source, /collapsed-title="最近发送记录"/);
    assert.match(source, /WorkbenchCard/);
    assert.match(source, /class="min-w-0 break-all font-mono text-small text-text-secondary"/);
    assert.match(source, /class="mt-1 break-all font-mono text-small text-text-muted"/);
  });
