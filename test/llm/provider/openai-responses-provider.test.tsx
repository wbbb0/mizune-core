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
    chat: { capabilities: { supportsThinking: true, thinkingControllable: true, supportsVision: true, supportsTools: true, supportsSearch: true }, searchEnabled: true },
    ...modelOverrides
  });
  config.llm.providers.test!.type = "openai_responses_compatible";
  delete config.llm.providers.test!.baseUrl;
  config.llm.models.main!.chat!.searchEnabled = true;
  config.llm.models.main!.chat!.capabilities.supportsSearch = true;
  return config;
}

test("openai responses provider maps request content, tools, parameters, and streamed output", async () => {
  const config = createOpenAiResponsesConfig({
    chat: {
      defaults: {
      temperature: 0.4,
      top_p: 0.8,
      top_k: 20,
      presence_penalty: 0.2,
      extra: {
        max_output_tokens: 512,
        store: true
      }
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
        assert.equal(body.max_output_tokens, 256);
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
        maxOutputTokensOverride: 256,
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
              provider: "test",
              providerType: "openai_responses_compatible",
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-5.6",
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
    createOpenAiResponsesConfig({
      chat: { capabilities: { supportsThinking: false, thinkingControllable: false } }
    }),
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

function createOfficialOpenAiConfig(modelOverrides: Record<string, unknown> = {}) {
  const config = createOpenAiResponsesConfig(modelOverrides);
  config.llm.providers.test!.type = "openai";
  return config;
}

test("official OpenAI uses native Responses parameters and preserves cited sources", async () => {
  const config = createOfficialOpenAiConfig({
    chat: {
      defaults: {
        reasoningEffort: "high",
        verbosity: "low",
        extra: { model: "wrong-model", stream: false, previous_response_id: "foreign-chain", conversation: "foreign-conversation", background: true }
      }
    }
  });
  const outputItems = [{
    type: "web_search_call",
    id: "search_1",
    status: "completed",
    action: { type: "search", sources: [{ url: "https://example.com/source", title: "资料" }] }
  }, {
    type: "message",
    role: "assistant",
    content: [{
      type: "output_text",
      text: "  有依据的回答",
      annotations: [
        { type: "url_citation", url: "https://example.com/source", title: "资料", start_index: 2, end_index: 5 },
        { type: "url_citation", url: "javascript:alert(1)", title: "恶意链接", start_index: 2, end_index: 5 }
      ]
    }]
  }];
  const client = new LlmClient(config, pino({ level: "silent" }));
  await withMockFetch([{
    assertRequest(body: any) {
      assert.equal(body.model, "gpt-5.6");
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(body.previous_response_id, undefined);
      assert.equal(body.conversation, undefined);
      assert.equal(body.background, undefined);
      assert.deepEqual(body.reasoning, { summary: "auto", effort: "high" });
      assert.deepEqual(body.text, { verbosity: "low" });
      assert.deepEqual(body.include, ["reasoning.encrypted_content", "web_search_call.action.sources"]);
      assert.deepEqual(body.tools, [{ type: "web_search" }]);
    },
    payloads: [{ type: "response.completed", response: { id: "resp_citations", status: "completed", output: outputItems } }]
  }], async () => {
    const result = await client.generate({ messages: [{ role: "user", content: "查询资料" }], enableThinkingOverride: true });
    assert.equal(result.text, "有依据的回答\n\n参考来源：\n1. [资料](https://example.com/source)");
    assert.deepEqual(result.assistantMetadata?.citations, [{ url: "https://example.com/source", title: "资料", startIndex: 0, endIndex: 3 }]);
    assert.deepEqual(result.assistantMetadata?.searchSources, [{ url: "https://example.com/source", title: "资料" }]);
    assert.deepEqual(result.assistantMetadata?.openAiResponses, { provider: "test", providerType: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6", responseId: "resp_citations", outputItems });
  });
});

test("official OpenAI maps structured output and thinking disable independently", async () => {
  const config = createOfficialOpenAiConfig({ chat: { defaults: { reasoningEffort: "high", verbosity: "medium" } } });
  const client = new LlmClient(config, pino({ level: "silent" }));
  const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  await withMockFetch([{
    assertRequest(body: any) {
      assert.deepEqual(body.reasoning, { effort: "none" });
      assert.deepEqual(body.text, { verbosity: "medium", format: { type: "json_schema", name: "answer", schema, strict: true } });
    },
    payloads: [{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"answer":"内容"}' }] }] } }]
  }], async () => {
    const result = await client.generate({
      messages: [{ role: "user", content: "回答" }],
      enableThinkingOverride: false,
      responseFormat: { type: "json_schema", name: "answer", schema }
    });
    assert.equal(result.text, '{"answer":"内容"}');
  });
});

test("Responses never replays opaque items from another provider or upstream model", async () => {
  const config = createOfficialOpenAiConfig();
  const client = new LlmClient(config, pino({ level: "silent" }));
  await withMockFetch([{
    assertRequest(body: any) {
      assert.deepEqual(body.input, [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "原回答", annotations: [] }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] }]);
    },
    payloads: [{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "新回答" }] }] } }]
  }], async () => {
    await client.generate({
      messages: [{ role: "assistant", content: "原回答", providerMetadata: { openAiResponses: { provider: "different-provider", model: "different-model", outputItems: [{ type: "reasoning", encrypted_content: "wrong-key" }] } } }, { role: "user", content: "继续" }]
    });
  });
});

test("compatible Chat Completions maps the same structured output contract", async () => {
  const config = createOpenAiResponsesConfig();
  config.llm.providers.test!.type = "openai_compatible";
  config.llm.models.main!.chat!.searchEnabled = false;
  const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  const client = new LlmClient(config, pino({ level: "silent" }));
  await withMockFetch([{
    assertRequest(body: any, _index: number, _init: RequestInit, url: string) {
      assert.equal(url, "https://api.openai.com/v1/chat/completions");
      assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: "answer", schema, strict: true } });
    },
    payloads: [{ choices: [{ delta: { content: '{"answer":"内容"}' }, finish_reason: "stop" }] }]
  }], async () => {
    const result = await client.generate({ messages: [{ role: "user", content: "回答" }], responseFormat: { type: "json_schema", name: "answer", schema } });
    assert.equal(result.text, '{"answer":"内容"}');
  });
});

test("official Responses rejects an already cancelled request before transport", async () => {
  const config = createOfficialOpenAiConfig();
  const client = new LlmClient(config, pino({ level: "silent" }));
  const controller = new AbortController();
  controller.abort();
  await withMockFetch([], async () => {
    await assert.rejects(client.generate({ messages: [{ role: "user", content: "取消" }], abortSignal: controller.signal }), /abort/i);
  });
});

test("Responses binds opaque replay to protocol type and normalized endpoint", async () => {
  for (const change of ["type", "endpoint", "normalized_endpoint"] as const) {
    const config = createOfficialOpenAiConfig();
    config.llm.providers.test!.baseUrl = "https://API.OPENAI.COM:443/v1///";
    const client = new LlmClient(config, pino({ level: "silent" }));
    const reasoning = { type: "reasoning", id: "reasoning_original", encrypted_content: "opaque-content", summary: [] };
    const message = { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "原回答", annotations: [] }] };
    await withMockFetch([{
      assertRequest() {},
      payloads: [{ type: "response.completed", response: { status: "completed", output: [reasoning, message] } }]
    }, {
      assertRequest(body: any) {
        if (change === "normalized_endpoint") {
          assert.deepEqual(body.input.slice(0, 2), [reasoning, message]);
        } else {
          assert.deepEqual(body.input[0], { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "原回答", annotations: [] }] });
          assert.equal(body.input.some((item: any) => item.type === "reasoning"), false);
        }
      },
      payloads: [{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "新回答" }] }] } }]
    }], async () => {
      const previous = await client.generate({ messages: [{ role: "user", content: "回答" }] });
      const identity = previous.assistantMetadata?.openAiResponses as Record<string, unknown>;
      assert.equal(identity.baseUrl, "https://api.openai.com/v1");
      assert.equal(identity.providerType, "openai");
      if (change === "type") config.llm.providers.test!.type = "openai_responses_compatible";
      config.llm.providers.test!.baseUrl = change === "endpoint" ? "https://another.example/v1" : "https://api.openai.com/v1";
      await client.generate({ messages: [{ role: "assistant", content: previous.text, providerMetadata: previous.assistantMetadata! }, { role: "user", content: "继续" }] });
    });
  }
});

test("structured Responses retains valid JSON while preserving search citations as metadata", async () => {
  for (const format of ["json_object", "json_schema"] as const) {
    const config = createOfficialOpenAiConfig();
    const client = new LlmClient(config, pino({ level: "silent" }));
    const answer = '{"answer":"有依据"}';
    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
    await withMockFetch([{
      assertRequest(body: any) {
        assert.deepEqual(body.tools, [{ type: "web_search" }]);
        assert.equal(body.text.format.type, format);
      },
      payloads: [{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{
        type: "output_text", text: answer,
        annotations: [{ type: "url_citation", url: "https://example.com/source", title: "资料", start_index: 11, end_index: 14 }]
      }] }] } }]
    }], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "查询后输出 JSON" }],
        responseFormat: format === "json_object" ? { type: "json_object" } : { type: "json_schema", name: "answer", schema }
      });
      assert.equal(result.text, answer);
      assert.deepEqual(JSON.parse(result.text), { answer: "有依据" });
      assert.equal((result.assistantMetadata?.citations as unknown[]).length, 1);
    });
  }
});

test("official Responses rejects chat audio before HTTP and points to native transcription", async () => {
  const config = createOfficialOpenAiConfig();
  const client = new LlmClient(config, pino({ level: "silent" }));
  await withMockFetch([], async () => {
    await assert.rejects(client.generate({ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "YXVkaW8=", format: "wav" } }] }] }), /不接受聊天音频输入.*音频转写/);
  });
});

test("Responses-compatible chat audio retains its explicitly configured wire format", async () => {
  const config = createOpenAiResponsesConfig();
  const client = new LlmClient(config, pino({ level: "silent" }));
  await withMockFetch([{
    assertRequest(body: any) {
      assert.deepEqual(body.input, [{ type: "message", role: "user", content: [{ type: "input_audio", input_audio: { data: "YXVkaW8=", format: "wav" } }] }]);
    },
    payloads: [{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "转写内容" }] }] } }]
  }], async () => {
    const result = await client.generate({ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "YXVkaW8=", format: "wav" } }] }] });
    assert.equal(result.text, "转写内容");
  });
});
