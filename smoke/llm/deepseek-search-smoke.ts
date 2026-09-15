import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { loadConfig } from "#config/config.ts";
import { LlmClient } from "#llm/llmClient.ts";

// 只读取配置；所有覆盖均在内存中，绝不写实例目录。
const config = loadConfig(process.env);
const providerName = process.env.SMOKE_PROVIDER ?? "deepseek";
const modelName = process.env.SMOKE_MODEL ?? "deepseek-flash";
const selected = Object.entries(config.llm.models).find(([, m]) => m.provider === providerName && m.model === modelName);
assert.ok(selected, "配置中未找到指定 provider/model");
const [modelRef, model] = selected;
const provider = config.llm.providers[providerName]!;
assert.equal(provider.type, "deepseek");
model.supportsSearch = true;
provider.search.maxUses = 3;
model.apiParameters = { maxOutputTokens: 4096 };
config.llm.debugDump.enabled = false;
config.llm.timeoutMs = 180000;
config.llm.firstTokenTimeoutMs = 60000;
const temp = await mkdtemp(join(tmpdir(), "deepseek-search-smoke-"));
config.dataDir = temp;
const client = new LlmClient(config, pino({ level: "silent" }));
function blocks(metadata?: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(metadata?.anthropicContentBlocks) ? metadata.anthropicContentBlocks : [];
}
try {
  const search = await client.generate({
    modelRefOverride: modelRef,
    messages: [{ role: "user", content: "请实际使用联网搜索，查找 DeepSeek 官方 Anthropic API 文档，给出页面标题和网址，简短回答。" }],
    enableThinkingOverride: false
  });
  const searchMetadata = search.assistantMetadata;
  assert.ok(searchMetadata, "缺少搜索回传元数据");
  const searchBlocks = blocks(searchMetadata);
  assert.ok(searchBlocks.some(b => b.type === "server_tool_use"));
  const sources = searchBlocks.filter(b => b.type === "web_search_tool_result").flatMap(b => Array.isArray(b.content) ? b.content : []).filter(b => b.type === "web_search_result");
  assert.ok(sources.length > 0, "未收到真实搜索结果");
  assert.ok(search.text.length > 0);
  console.log(JSON.stringify({ case: "native-search", modelRef, passed: true, sources: sources.map(s => ({ title: s.title, url: s.url })), usage: search.usage }));

  // 在真实搜索结果之后加入普通工具调用，验证内容块回传和思考续轮。
  let calls = 0;
  let reasoningSeen = false;
  const continuation = await client.generate({
    modelRefOverride: modelRef,
    enableThinkingOverride: true,
    onProviderResponseComplete: event => { reasoningSeen ||= event.reasoningContent.length > 0; },
    messages: [
      { role: "user", content: "查找 DeepSeek 官方 Anthropic API 文档" },
      { role: "assistant", content: search.text, providerMetadata: searchMetadata },
      { role: "user", content: "请调用 smoke_echo 获取校验码，然后在最终回答中原样返回校验码。不需要再次搜索。" }
    ],
    tools: [{ type: "function", function: { name: "smoke_echo", description: "获取本次测试的校验码", parameters: { type: "object", properties: {}, additionalProperties: false } } }],
    toolExecutor: async (call) => { assert.equal(call.function.name, "smoke_echo"); calls++; return "校验码：DS_SEARCH_REPLAY_OK_731"; }
  });
  assert.ok(reasoningSeen, "未收到真实思考内容");
  assert.ok(calls > 0, "未执行普通工具");
  assert.match(continuation.text, /DS_SEARCH_REPLAY_OK_731/);
  console.log(JSON.stringify({ case: "search-replay-thinking-function-tool", passed: true, toolCalls: calls, usage: continuation.usage }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
