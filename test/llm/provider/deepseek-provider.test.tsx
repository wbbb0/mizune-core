import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import { createLlmTestConfig, createToolDefinition, withMockFetch } from "../../helpers/llm-test-support.tsx";

function config(search = false) {
  const c = createLlmTestConfig({ model: "deepseek-flash", supportsThinking: true, supportsSearch: search, preserveThinking: true });
  c.llm.providers.test!.type = "deepseek";
  delete c.llm.providers.test!.baseUrl;
  c.llm.providers.test!.search.maxUses = 2;
  return c;
}
function events(blocks: Record<string, unknown>[]) {
  return [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 4 } } },
    ...blocks.flatMap((content_block, index) => [{ type: "content_block_start", index, content_block }, { type: "content_block_stop", index }]),
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" }
  ];
}
const answer = events([{ type: "text", text: "回答" }]);

test("deepseek uses Anthropic endpoint, authentication, thinking and model parameters", async () => {
  const c = config();
  c.llm.models.main!.apiParameters = { temperature: 0.65, maxOutputTokens: 2048 };
  await withMockFetch([{ assertRequest(body: any, _: number, init: RequestInit, url: string) {
    assert.equal(url, "https://api.deepseek.com/anthropic/v1/messages");
    assert.equal((init.headers as Record<string, string>)["x-api-key"], "test-key");
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.deepEqual(body.output_config, { effort: "high" });
    assert.equal(body.max_tokens, 2048);
    assert.equal(body.temperature, 0.65);
    assert.equal(body.system, "中文系统指令");
    assert.equal(body.stream_options, undefined);
  }, payloads: answer }], async () => {
    const r = await new LlmClient(c, pino({ level: "silent" })).generate({ messages: [{ role: "system", content: "中文系统指令" }, { role: "user", content: "你好" }], enableThinkingOverride: true });
    assert.equal(r.text, "回答");
    assert.equal(r.usage.outputTokens, 7);
    assert.equal(r.usage.cachedTokens, 4);
    assert.equal(r.usage.inputTokens, 14);
    assert.equal(r.usage.totalTokens, 21);
  });
});

test("deepseek search results survive ordinary tool continuation without becoming client tools", async () => {
  const c = config(true);
  const server = { type: "server_tool_use", id: "search-1", name: "web_search", input: { query: "官方文档" } };
  const result = { type: "web_search_tool_result", tool_use_id: "search-1", content: [{ type: "web_search_result", title: "官方文档", url: "https://api-docs.deepseek.com/", encrypted_content: "opaque-replay" }] };
  const first = events([server, result, { type: "tool_use", id: "call-1", name: "lookup", input: {} }]);
  let calls = 0;
  await withMockFetch([
    { assertRequest(body: any) {
      assert.ok(body.tools.some((t: any) => t.type === "web_search_20250305"));
      assert.ok(body.tools.some((t: any) => t.name === "lookup" && t.input_schema));
    }, payloads: first },
    { assertRequest(body: any) {
      const assistant = body.messages.find((m: any) => m.role === "assistant");
      assert.deepEqual(assistant.content.slice(0, 2), [server, result]);
      assert.equal(body.messages.at(-1).content[0].type, "tool_result");
      assert.equal(body.messages.at(-1).content[0].tool_use_id, "call-1");
    }, payloads: answer }
  ], async () => {
    const r = await new LlmClient(c, pino({ level: "silent" })).generate({ messages: [{ role: "user", content: "查询" }], tools: [createToolDefinition("lookup")], toolExecutor: async () => { calls++; return "完成"; } });
    assert.equal(r.text, "回答");
    assert.equal(calls, 1);
  });
});

test("deepseek disabled search omits server tool and disabled thinking omits effort", async () => {
  await withMockFetch([{ assertRequest(body: any) {
    assert.equal(body.tools, undefined);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.output_config, undefined);
  }, payloads: answer }], async () => {
    await new LlmClient(config(), pino({ level: "silent" })).generate({ messages: [{ role: "user", content: "你好" }], enableThinkingOverride: false });
  });
});

test("deepseek retains server search failures as metadata alongside final answer", async () => {
  const failure = { type: "web_search_tool_result", tool_use_id: "search-1", content: [{ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }] };
  await withMockFetch([{ assertRequest() {}, payloads: events([failure, { type: "text", text: "搜索达到上限" }]) }], async () => {
    const r = await new LlmClient(config(true), pino({ level: "silent" })).generate({ messages: [{ role: "user", content: "搜索" }] });
    assert.deepEqual((r.assistantMetadata?.anthropicContentBlocks as unknown[])[0], failure);
  });
});

test("deepseek rejects incomplete streams and token truncation", async () => {
  for (const payloads of [answer.slice(0, -1), answer.map(p => p.type === "message_delta" ? { ...p, delta: { stop_reason: "max_tokens" } } : p)]) {
    await withMockFetch([{ assertRequest() {}, payloads }], async () => {
      await assert.rejects(new LlmClient(config(), pino({ level: "silent" })).generate({ messages: [{ role: "user", content: "你好" }] }), /DeepSeek 响应/);
    });
  }
});

test("deepseek assembles streaming search arguments and thinking deltas", async () => {
  const payloads = [
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "先" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "搜索" } },
    { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"官方文档"}' } },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "完成" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5, server_tool_use: { web_search_requests: 1 } } },
    { type: "message_stop" }
  ];
  await withMockFetch([{ assertRequest() {}, payloads }], async () => {
    const r = await new LlmClient(config(true), pino({ level: "silent" })).generate({ messages: [{ role: "user", content: "搜索" }], enableThinkingOverride: true });
    assert.equal(r.reasoningContent, "先搜索");
    assert.equal(r.text, "完成");
    assert.deepEqual((r.assistantMetadata?.anthropicContentBlocks as any[])[1].input, { query: "官方文档" });
    assert.deepEqual((r.assistantMetadata?.anthropicUsage as any).server_tool_use, { web_search_requests: 1 });
  });
});

for (const type of ["deepseek", "anthropic"] as const) {
  test(`${type} preserves planner output limit override`, async () => {
    const c = config();
    c.llm.providers.test!.type = type;
    c.llm.models.main!.apiParameters = { maxOutputTokens: 8192 };
    await withMockFetch([{ assertRequest(body: any) {
      assert.equal(body.max_tokens, 512);
    }, payloads: answer }], async () => {
      await new LlmClient(c, pino({ level: "silent" })).generate({
        messages: [{ role: "user", content: "你好" }], enableThinkingOverride: false, maxOutputTokensOverride: 512
      });
    });
  });
}
