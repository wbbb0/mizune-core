import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import {
  createLlmTestConfig,
  createToolDefinition,
  withMockFetch
} from "../../helpers/llm-test-support.tsx";

function createOpenAiResponsesConfig(modelOverrides: Record<string, unknown> = {}) {
  const config = createLlmTestConfig({
    provider: "test",
    model: "gpt-5.6",
    supportsThinking: true,
    thinkingControllable: true,
    supportsVision: true,
    supportsSearch: true,
    supportsTools: true,
    ...modelOverrides
  });
  config.llm.providers.test!.type = "openai_responses";
  delete config.llm.providers.test!.baseUrl;
  return config;
}

test("openai responses provider maps request content, tools, parameters, and streamed output", async () => {
  const config = createOpenAiResponsesConfig({
    apiParameters: {
      temperature: 0.4,
      top_p: 0.8,
      top_k: 20,
      presence_penalty: 0.2,
      extra: {
        max_output_tokens: 512,
        store: true
      }
    }
  });
  config.llm.providers.test!.features.search = {
    type: "builtin_tool",
    tool: {
      type: "web_search"
    }
  };
  const client = new LlmClient(config, pino({ level: "silent" }));
  const textDeltas: string[] = [];
  const reasoningDeltas: string[] = [];

  await withMockFetch([
    {
      assertRequest(body: any, _callIndex: number, init: RequestInit, url: string) {
        assert.equal(url, "https://api.openai.com/v1/responses");
        assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-key");
        assert.equal(body.model, "gpt-5.6");
        assert.equal(body.stream, true);
        assert.equal(body.store, false);
        assert.equal(body.temperature, 0.4);
        assert.equal(body.top_p, 0.8);
        assert.equal(body.max_output_tokens, 512);
        assert.equal("top_k" in body, false);
        assert.equal("presence_penalty" in body, false);
        assert.deepEqual(body.reasoning, { effort: "none" });
        assert.deepEqual(body.input, [
          {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: "你是助手" }]
          },
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "描述图片" },
              {
                type: "input_image",
                image_url: "data:image/png;base64,AAAA",
                detail: "auto"
              }
            ]
          }
        ]);
        assert.deepEqual(body.tools, [
          {
            type: "function",
            name: "lookup",
            description: "lookup tool",
            parameters: {
              type: "object",
              properties: {}
            },
            strict: false
          },
          {
            type: "web_search"
          }
        ]);
      },
      payloads: [
        {
          type: "response.reasoning_summary_text.delta",
          delta: "简要分析"
        },
        {
          type: "response.output_text.delta",
          delta: "图中"
        },
        {
          type: "response.output_text.delta",
          delta: "有山"
        },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            status: "completed",
            output: [{
              type: "message",
              role: "assistant",
              content: [{
                type: "output_text",
                text: "图中有山",
                annotations: []
              }]
            }],
            usage: {
              input_tokens: 20,
              output_tokens: 8,
              total_tokens: 28,
              input_tokens_details: {
                cached_tokens: 5
              },
              output_tokens_details: {
                reasoning_tokens: 3
              }
            }
          }
        }
      ]
    }
  ], async () => {
    const result = await client.generate({
      messages: [
        { role: "system", content: "你是助手" },
        {
          role: "user",
          content: [
            { type: "text", text: "描述图片" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
          ]
        }
      ],
      tools: [createToolDefinition("lookup")],
      enableThinkingOverride: false,
      onTextDelta: (delta) => {
        textDeltas.push(delta);
      },
      onReasoningDelta: (delta) => {
        reasoningDeltas.push(delta);
      }
    });

    assert.equal(result.text, "图中有山");
    assert.equal(result.reasoningContent, "简要分析");
    assert.deepEqual(textDeltas, ["图中", "有山"]);
    assert.deepEqual(reasoningDeltas, ["简要分析"]);
    assert.equal(result.usage.inputTokens, 20);
    assert.equal(result.usage.outputTokens, 8);
    assert.equal(result.usage.cachedTokens, 5);
    assert.equal(result.usage.reasoningTokens, 3);
    assert.deepEqual((result.assistantMetadata as any)?.openAiResponses.outputItems, [{
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "图中有山",
        annotations: []
      }]
    }]);
  });
});

test("openai responses provider replays opaque output items through a tool roundtrip", async () => {
  const client = new LlmClient(
    createOpenAiResponsesConfig(),
    pino({ level: "silent" })
  );
  const reasoningItem = {
    id: "rs_1",
    type: "reasoning",
    encrypted_content: "encrypted-reasoning",
    summary: [{
      type: "summary_text",
      text: "需要查询"
    }]
  };
  const functionCallItem = {
    id: "fc_1",
    type: "function_call",
    call_id: "call_1",
    name: "lookup",
    arguments: "{\"query\":\"weather\"}",
    status: "completed"
  };
  const assistantMessageItem = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{
      type: "output_text",
      text: "正在查询",
      annotations: []
    }]
  };
  const normalizedAssistantMessageItem = {
    ...assistantMessageItem,
    content: [{
      type: "output_text",
      text: "已开始查询",
      annotations: []
    }]
  };

  await withMockFetch([
    {
      assertRequest(body: any) {
        assert.deepEqual(body.reasoning, { summary: "auto" });
        assert.deepEqual(body.input, [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "查天气" }]
        }]);
      },
      payloads: [
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            ...functionCallItem,
            arguments: ""
          }
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 1,
          delta: "{\"query\":"
        },
        {
          type: "response.completed",
          response: {
            id: "resp_tools",
            status: "completed",
            output: [reasoningItem, assistantMessageItem, functionCallItem],
            usage: {
              input_tokens: 10,
              output_tokens: 6,
              total_tokens: 16,
              output_tokens_details: {
                reasoning_tokens: 2
              }
            }
          }
        }
      ]
    },
    {
      assertRequest(body: any) {
        assert.deepEqual(body.reasoning, { summary: "auto" });
        assert.deepEqual(body.input, [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "查天气" }]
          },
          reasoningItem,
          normalizedAssistantMessageItem,
          functionCallItem,
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "{\"temperature\":25}"
          }
        ]);
      },
      payloads: [{
        type: "response.completed",
        response: {
          id: "resp_final",
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "现在 25 度",
              annotations: []
            }]
          }],
          usage: {
            input_tokens: 18,
            output_tokens: 4,
            total_tokens: 22
          }
        }
      }]
    }
  ], async () => {
    const result = await client.generate({
      messages: [{ role: "user", content: "查天气" }],
      tools: [createToolDefinition("lookup")],
      enableThinkingOverride: true,
      resolveAssistantToolCallContent: () => "已开始查询",
      toolExecutor: async () => "{\"temperature\":25}"
    });

    assert.equal(result.text, "现在 25 度");
    assert.equal(result.usage.requestCount, 2);
    assert.equal(result.usage.inputTokens, 28);
    assert.equal(result.usage.outputTokens, 10);
  });
});

test("openai responses provider replays final response output items on the next turn", async () => {
  const client = new LlmClient(
    createOpenAiResponsesConfig(),
    pino({ level: "silent" })
  );
  const reasoningItem = {
    id: "rs_previous",
    type: "reasoning",
    encrypted_content: "encrypted-previous",
    summary: []
  };
  const assistantItem = {
    id: "msg_previous",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{
      type: "output_text",
      text: "上一轮回答",
      annotations: []
    }]
  };

  await withMockFetch([
    {
      assertRequest(body: any) {
        assert.deepEqual(body.input, [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "上一轮问题" }]
          },
          reasoningItem,
          assistantItem,
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "继续" }]
          }
        ]);
      },
      payloads: [{
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "下一轮回答",
              annotations: []
            }]
          }]
        }
      }]
    }
  ], async () => {
    const result = await client.generate({
      messages: [
        { role: "user", content: "上一轮问题" },
        {
          role: "assistant",
          content: "上一轮回答",
          providerMetadata: {
            openAiResponses: {
              outputItems: [reasoningItem, assistantItem]
            }
          }
        },
        { role: "user", content: "继续" }
      ],
      enableThinkingOverride: true
    });

    assert.equal(result.text, "下一轮回答");
  });
});

test("openai responses provider synthesizes response items for foreign tool history", async () => {
  const client = new LlmClient(
    createOpenAiResponsesConfig({ supportsThinking: false, thinkingControllable: false }),
    pino({ level: "silent" })
  );

  await withMockFetch([
    {
      assertRequest(body: any) {
        assert.deepEqual(body.input, [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "继续" }]
          },
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{
              type: "output_text",
              text: "我先查询",
              annotations: []
            }]
          },
          {
            type: "function_call",
            call_id: "foreign_call",
            name: "lookup",
            arguments: "{}"
          },
          {
            type: "function_call_output",
            call_id: "foreign_call",
            output: "ok"
          }
        ]);
      },
      payloads: [{
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "完成",
              annotations: []
            }]
          }]
        }
      }]
    }
  ], async () => {
    const result = await client.generate({
      messages: [
        { role: "user", content: "继续" },
        {
          role: "assistant",
          content: "我先查询",
          tool_calls: [{
            id: "foreign_call",
            type: "function",
            function: {
              name: "lookup",
              arguments: "{}"
            }
          }]
        },
        {
          role: "tool",
          tool_call_id: "foreign_call",
          content: "ok"
        }
      ]
    });

    assert.equal(result.text, "完成");
  });
});

test("openai responses provider preserves top-level SSE error diagnostics", async () => {
  const client = new LlmClient(
    createOpenAiResponsesConfig(),
    pino({ level: "silent" })
  );

  await assert.rejects(
    withMockFetch([
      {
        assertRequest() {},
        payloads: [{
          type: "error",
          code: "server_error",
          message: "upstream unavailable",
          param: null
        }]
      }
    ], async () => {
      await client.generate({
        messages: [{ role: "user", content: "继续" }]
      });
    }),
    /server_error upstream unavailable/
  );
});

test("openai responses provider rejects incomplete streams", async () => {
  const client = new LlmClient(
    createOpenAiResponsesConfig(),
    pino({ level: "silent" })
  );

  await assert.rejects(
    withMockFetch([
      {
        assertRequest() {},
        payloads: [{
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: {
              reason: "max_output_tokens"
            }
          }
        }]
      }
    ], async () => {
      await client.generate({
        messages: [{ role: "user", content: "继续" }]
      });
    }),
    /stream incomplete: max_output_tokens/
  );
});
