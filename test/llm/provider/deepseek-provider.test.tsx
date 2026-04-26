import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import { createLlmTestConfig, createToolDefinition, withMockFetch } from "../../helpers/llm-test-support.tsx";

function createDeepSeekConfig() {
  const config = createLlmTestConfig({
    provider: "test",
    model: "deepseek-v4-pro",
    supportsThinking: true,
    supportsTools: true
  });
  config.llm.providers.test!.type = "deepseek";
  delete config.llm.providers.test!.baseUrl;
  return config;
}

test("deepseek provider sends native thinking switch and effort", async () => {
  const client = new LlmClient(createDeepSeekConfig(), pino({ level: "silent" }));

  await withMockFetch([
    {
      assertRequest(body: any, _callIndex: number, init: RequestInit, url: string) {
        assert.equal(url, "https://api.deepseek.com/chat/completions");
        assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-key");
        assert.equal(body.model, "deepseek-v4-pro");
        assert.equal(body.stream, true);
        assert.deepEqual(body.thinking, { type: "enabled" });
        assert.equal(body.reasoning_effort, "high");
      },
      payloads: [{
        choices: [{
          delta: {
            reasoning_content: "先思考。"
          }
        }]
      }, {
        choices: [{
          delta: {
            content: "回答"
          }
        }]
      }, {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 7,
          total_tokens: 17,
          prompt_cache_hit_tokens: 4,
          completion_tokens_details: {
            reasoning_tokens: 3
          }
        }
      }]
    }
  ], async () => {
    const result = await client.generate({
      messages: [{ role: "user", content: "你好" }],
      enableThinkingOverride: true
    });

    assert.equal(result.text, "回答");
    assert.equal(result.reasoningContent, "先思考。");
    assert.equal(result.usage.cachedTokens, 4);
    assert.equal(result.usage.reasoningTokens, 3);
  });
});

test("deepseek provider disables thinking without reasoning effort", async () => {
  const client = new LlmClient(createDeepSeekConfig(), pino({ level: "silent" }));

  await withMockFetch([
    {
      assertRequest(body: any) {
        assert.deepEqual(body.thinking, { type: "disabled" });
        assert.equal("reasoning_effort" in body, false);
      },
      payloads: [{
        choices: [{
          delta: {
            content: "不思考回答"
          }
        }]
      }]
    }
  ], async () => {
    const result = await client.generate({
      messages: [{ role: "user", content: "你好" }],
      enableThinkingOverride: false
    });

    assert.equal(result.text, "不思考回答");
  });
});

test("deepseek provider keeps reasoning content on tool roundtrips", async () => {
  const client = new LlmClient(createDeepSeekConfig(), pino({ level: "silent" }));

  await withMockFetch([
    {
      assertRequest(body: any) {
        assert.deepEqual(body.thinking, { type: "enabled" });
        assert.equal(body.messages.length, 1);
      },
      payloads: [{
        choices: [{
          delta: {
            reasoning_content: "需要查资料。"
          }
        }]
      }, {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: {
                name: "lookup",
                arguments: "{\"query\":\"deepseek\"}"
              }
            }]
          }
        }]
      }]
    },
    {
      assertRequest(body: any) {
        assert.equal(body.messages.length, 3);
        assert.equal(body.messages[1].role, "assistant");
        assert.equal(body.messages[1].reasoning_content, "需要查资料。");
        assert.equal(body.messages[1].tool_calls[0].id, "call_1");
        assert.equal(body.messages[2].role, "tool");
      },
      payloads: [{
        choices: [{
          delta: {
            content: "工具后回答"
          }
        }]
      }]
    }
  ], async () => {
    const result = await client.generate({
      messages: [{ role: "user", content: "查一下" }],
      tools: [createToolDefinition("lookup")],
      toolExecutor: async () => "{\"ok\":true}",
      enableThinkingOverride: true
    });

    assert.equal(result.text, "工具后回答");
  });
});
