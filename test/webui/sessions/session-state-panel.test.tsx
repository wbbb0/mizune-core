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
    assert.doesNotMatch(source, /SessionPacingControl/);
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
    assert.doesNotMatch(source, /最近 Evidence/);
    assert.match(source, /WorkbenchDisclosure/);
    assert.match(source, /collapsed-title="派生观察"/);
    assert.doesNotMatch(source, /collapsed-title="最近工具事件"/);
    assert.match(source, /collapsed-title="最近发送记录"/);
    assert.match(source, /WorkbenchCard/);
    assert.match(source, /class="min-w-0 break-all font-mono text-small text-text-secondary"/);
    assert.match(source, /class="mt-1 break-all font-mono text-small text-text-muted"/);
  });

test("session settings panel edits toolset boundary and pacing as one atomic draft", async () => {
  const panel = await readFile(
    new URL("../../../webui/src/components/sessions/SessionSettingsPanel.vue", import.meta.url),
    "utf8"
  );
  const pacingControl = await readFile(
    new URL("../../../webui/src/components/sessions/SessionPacingControl.vue", import.meta.url),
    "utf8"
  );
  const toolsetControl = await readFile(
    new URL("../../../webui/src/components/sessions/SessionToolsetBoundaryControl.vue", import.meta.url),
    "utf8"
  );

  assert.match(panel, /sessionsApi\.fetchSettings/);
  assert.match(panel, /sessionsApi\.updateSettings/);
  assert.match(panel, /cloneSessionSettings\(draft\.value\)/);
  assert.doesNotMatch(panel, /structuredClone/);
  assert.match(panel, /<SessionToolsetBoundaryControl/);
  assert.match(panel, /<SessionPacingControl/);
  assert.match(panel, /保存设置/);
  assert.match(pacingControl, /用户消息聚合等待/);
  assert.match(pacingControl, /全局自适应/);
  assert.match(pacingControl, /立即处理/);
  assert.match(pacingControl, /固定等待秒数/);
  assert.match(pacingControl, /OneBot 回复模拟输入延迟/);
  assert.match(pacingControl, /模型回复输出方式/);
  assert.match(pacingControl, /仅输出最终回复/);
  assert.match(pacingControl, /所有回复都会等待整轮生成完成后一次投递/);
  assert.doesNotMatch(pacingControl, /sessionsApi/);
  assert.match(toolsetControl, /模型可用工具边界/);
  assert.match(toolsetControl, /限制 Planner 的候选工具集/);
  assert.match(toolsetControl, /恢复模式默认/);
  assert.match(toolsetControl, /delete overrides\[option\.id\]/);
});
