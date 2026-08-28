import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import { createAssistantToolRoundtripMessages, createLlmTestConfig, createToolDefinition, withMockFetch } from "../../helpers/llm-test-support.tsx";
import { buildTag } from "../../../src/utils/structuredEnvelope.ts";

function createNativeLmStudioSseResponse(payloads: any[]) {
  const encoder = new TextEncoder();
  const raw = payloads
    .map((payload) => `event: ${payload.type ?? "message"}\ndata: ${JSON.stringify(payload)}\n\n`)
    .join("");
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      }
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream"
      }
    }
  );
}

function createUnterminatedSseResponse(payload: any) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}`));
        controller.close();
      }
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream"
      }
    }
  );
}

  test("native search injects provider flag into request body", async () => {
    const config = createLlmTestConfig({ supportsSearch: true });
    config.llm.providers.test!.features.search = {
      type: "flag",
      path: "extra_body.enable_search"
    };
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.extra_body.enable_search, true);
          assert.deepEqual(
            (body.tools ?? []).map((tool: any) => tool.function.name),
            ["ground_with_google_search", "lookup"]
          );
        },
        payloads: [{
          choices: [{
            delta: {
              content: "done"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "search the latest news" }],
        tools: [createToolDefinition("ground_with_google_search"), createToolDefinition("lookup")]
      });

      assert.equal(result.text, "done");
    });
  });

  test("openai-compatible providers append builtin search tools from feature config", async () => {
    const config = createLlmTestConfig({ supportsSearch: true });
    config.llm.providers.test!.features.search = {
      type: "builtin_tool",
      tool: {
        type: "web_search_preview"
      }
    };
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.deepEqual(body.tools, [
            createToolDefinition("lookup"),
            { type: "web_search_preview" }
          ]);
        },
        payloads: [{
          choices: [{
            delta: {
              content: "done"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "search the latest news" }],
        tools: [createToolDefinition("lookup")]
      });

      assert.equal(result.text, "done");
    });
  });

  test("openai-compatible providers include configured model api parameters", async () => {
    const config = createLlmTestConfig({
      apiParameters: {
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        min_p: 0.05,
        presence_penalty: 0.2,
        repetition_penalty: 1.05,
        extra: {
          max_tokens: 256
        }
      }
    });
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.temperature, 0.7);
          assert.equal(body.top_p, 0.9);
          assert.equal(body.top_k, 40);
          assert.equal(body.min_p, 0.05);
          assert.equal(body.presence_penalty, 0.2);
          assert.equal(body.repetition_penalty, 1.05);
          assert.equal(body.max_tokens, 256);
        },
        payloads: [{
          choices: [{
            delta: {
              content: "done"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }]
      });

      assert.equal(result.text, "done");
    });
  });

  test("anthropic provider maps messages, tools, vision, and thinking internally", async () => {
    const config = createLlmTestConfig({
      provider: "test",
      model: "claude-test",
      supportsThinking: true,
      supportsVision: true,
      supportsTools: true,
      apiParameters: {
        temperature: 0.5,
        top_p: 0.8,
        top_k: 40,
        presence_penalty: 0.3,
        extra: {
          max_tokens: 2048,
          ignored_vendor_flag: true
        }
      }
    });
    config.llm.providers.test!.type = "anthropic";
    config.llm.providers.test!.baseUrl = "https://anthropic.example";
    config.llm.providers.test!.apiKey = "anthropic-key";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _index: number, init: RequestInit, url: string) {
          assert.equal(url, "https://anthropic.example/v1/messages");
          assert.equal((init.headers as Record<string, string>)["x-api-key"], "anthropic-key");
          assert.equal((init.headers as Record<string, string>)["anthropic-version"], "2023-06-01");
          assert.equal(body.model, "claude-test");
          assert.equal(body.stream, true);
          assert.equal(body.system, "system prompt");
          assert.equal(body.max_tokens, 2048);
          assert.deepEqual(body.thinking, {
            type: "enabled",
            budget_tokens: 1024
          });
          assert.equal(body.temperature, 0.5);
          assert.equal(body.top_p, 0.8);
          assert.equal(body.top_k, 40);
          assert.equal("presence_penalty" in body, false);
          assert.equal(body.ignored_vendor_flag, true);
          assert.deepEqual(body.tools, [{
            name: "lookup",
            description: "lookup tool",
            input_schema: {
              type: "object",
              properties: {}
            }
          }]);
          assert.deepEqual(body.messages, [
            {
              role: "user",
              content: [
                { type: "text", text: "see this" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "AAAA"
                  }
                }
              ]
            }
          ]);
        },
        payloads: [
          {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 10,
                output_tokens: 1
              }
            }
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "thinking",
              thinking: ""
            }
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "thinking_delta",
              thinking: "reason"
            }
          },
          {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "text",
              text: ""
            }
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "text_delta",
              text: "done"
            }
          },
          {
            type: "message_delta",
            usage: {
              output_tokens: 4
            }
          }
        ]
      }
    ], async () => {
      const result = await client.generate({
        messages: [
          { role: "system", content: "system prompt" },
          {
            role: "user",
            content: [
              { type: "text", text: "see this" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
            ]
          }
        ],
        tools: [createToolDefinition("lookup")],
        enableThinkingOverride: true
      });

      assert.equal(result.text, "done");
      assert.equal(result.reasoningContent, "reason");
      assert.equal(result.usage.inputTokens, 10);
      assert.equal(result.usage.outputTokens, 4);
    });
  });

  test("anthropic provider maps assistant tool use and tool results", async () => {
    const config = createLlmTestConfig({
      provider: "test",
      supportsThinking: false,
      supportsTools: true
    });
    config.llm.providers.test!.type = "anthropic";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.thinking, undefined);
          assert.deepEqual(body.messages, [
            { role: "user", content: "continue the task" },
            {
              role: "assistant",
              content: [{
                type: "tool_use",
                id: "tool-call-1",
                name: "lookup",
                input: { query: "test" }
              }]
            },
            {
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: "tool-call-1",
                content: "{\"ok\":true}"
              }]
            }
          ]);
        },
        payloads: [
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-call-2",
              name: "lookup",
              input: {}
            }
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: "{\"query\":\"next\"}"
            }
          }
        ]
      },
      {
        assertRequest(body: any) {
          assert.deepEqual(body.messages.at(-2), {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "tool-call-2",
              name: "lookup",
              input: { query: "next" }
            }]
          });
          assert.deepEqual(body.messages.at(-1), {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "tool-call-2",
              content: "{\"ok\":true}"
            }]
          });
        },
        payloads: [
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "text",
              text: ""
            }
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "final"
            }
          }
        ]
      }
    ], async () => {
      const result = await client.generate({
        messages: createAssistantToolRoundtripMessages(),
        tools: [createToolDefinition("lookup")],
        toolExecutor: async () => "{\"ok\":true}"
      });

      assert.equal(result.text, "final");
    });
  });

  test("anthropic provider replays normalized assistant tool-call content metadata", async () => {
    const config = createLlmTestConfig({
      provider: "test",
      supportsThinking: false,
      supportsTools: true
    });
    config.llm.providers.test!.type = "anthropic";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
        },
        payloads: [
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "text",
              text: ""
            }
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "看看便知。\n\n看看便知。"
            }
          },
          {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "tool-call-1",
              name: "lookup",
              input: { query: "test" }
            }
          }
        ]
      },
      {
        assertRequest(body: any) {
          assert.deepEqual(body.messages.at(-2), {
            role: "assistant",
            content: [
              { type: "text", text: "看看便知。" },
              {
                type: "tool_use",
                id: "tool-call-1",
                name: "lookup",
                input: { query: "test" }
              }
            ]
          });
        },
        payloads: [
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "text",
              text: ""
            }
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "final"
            }
          }
        ]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "查一下" }],
        tools: [createToolDefinition("lookup")],
        resolveAssistantToolCallContent: () => "看看便知。",
        toolExecutor: async () => "{\"ok\":true}"
      });

      assert.equal(result.text, "final");
    });
  });

  test("dashscope sends preserve_thinking when preserveThinking is enabled and assistant reasoning exists", async () => {
    const config = createLlmTestConfig({
      provider: "test",
      preserveThinking: true
    });
    config.llm.providers.test!.type = "dashscope";
    config.llm.providers.test!.features.thinking = {
      type: "flag",
      path: "enable_thinking"
    };
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.parameters.enable_thinking, true);
          assert.equal(body.parameters.preserve_thinking, true);
          assert.equal(body.input.messages[0].role, "assistant");
          assert.equal(body.input.messages[0].reasoning_content, "previous reasoning");
        },
        payloads: [{
          output: {
            choices: [{
              message: {
                content: [{ text: "done" }]
              }
            }]
          },
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            total_tokens: 6
          }
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [
          {
            role: "assistant",
            content: "previous answer",
            reasoning_content: "previous reasoning"
          },
          {
            role: "user",
            content: "continue"
          }
        ],
        enableThinkingOverride: true
      });

      assert.equal(result.text, "done");
    });
  });

  test("dashscope omits preserve_thinking when no assistant reasoning is present", async () => {
    const config = createLlmTestConfig({
      provider: "test",
      preserveThinking: true
    });
    config.llm.providers.test!.type = "dashscope";
    config.llm.providers.test!.features.thinking = {
      type: "flag",
      path: "enable_thinking"
    };
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.parameters.enable_thinking, true);
          assert.equal("preserve_thinking" in body.parameters, false);
        },
        payloads: [{
          output: {
            choices: [{
              message: {
                content: [{ text: "done" }]
              }
            }]
          },
          usage: {
            input_tokens: 4,
            output_tokens: 1,
            total_tokens: 5
          }
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }],
        enableThinkingOverride: true
      });

      assert.equal(result.text, "done");
    });
  });

  test("dashscope sends configured model api parameters under parameters", async () => {
    const config = createLlmTestConfig({
      provider: "test",
      apiParameters: {
        temperature: 0.6,
        top_p: 0.85,
        top_k: 20,
        min_p: 0.03,
        presence_penalty: 0.1,
        repetition_penalty: 1.1,
        extra: {
          max_tokens: 128
        }
      }
    });
    config.llm.providers.test!.type = "dashscope";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.parameters.temperature, 0.6);
          assert.equal(body.parameters.top_p, 0.85);
          assert.equal(body.parameters.top_k, 20);
          assert.equal(body.parameters.min_p, 0.03);
          assert.equal(body.parameters.presence_penalty, 0.1);
          assert.equal(body.parameters.repetition_penalty, 1.1);
          assert.equal(body.parameters.max_tokens, 128);
        },
        payloads: [{
          output: {
            choices: [{
              message: {
                content: [{ text: "done" }]
              }
            }]
          },
          usage: {
            input_tokens: 4,
            output_tokens: 1,
            total_tokens: 5
          }
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }]
      });

      assert.equal(result.text, "done");
    });
  });

  test("dashscope sends content safety inspection header when fallback is enabled", async () => {
    const config = createLlmTestConfig({
      provider: "test"
    });
    config.llm.providers.test!.type = "dashscope";
    config.contentSafety.routes.llmProviderFallback.dashscope.useDataInspectionHeader = true;
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(_body: any, _callIndex: number, init: RequestInit) {
          const headers = init.headers as Record<string, string>;
          assert.equal(headers["X-DashScope-DataInspection"], JSON.stringify({ input: "cip", output: "cip" }));
        },
        payloads: [{
          output: {
            choices: [{
              message: {
                content: [{ text: "done" }]
              }
            }]
          },
          usage: {
            input_tokens: 4,
            output_tokens: 1,
            total_tokens: 5
          }
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }]
      });

      assert.equal(result.text, "done");
    });
  });

  test("lmstudio sends preserve_thinking on openai-compatible chat completions when assistant reasoning exists", async () => {
    const config = createLlmTestConfig({
      preserveThinking: true
    });
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/v1/chat/completions");
          assert.equal(body.enable_thinking, true);
          assert.equal(body.preserve_thinking, true);
          const assistantMessage = body.messages.find((message: any) => message.role === "assistant");
          assert.equal(assistantMessage.reasoning_content, "previous reasoning");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "done"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [
          {
            role: "assistant",
            content: "previous answer",
            reasoning_content: "previous reasoning"
          },
          {
            role: "user",
            content: "continue"
          }
        ],
        enableThinkingOverride: true
      });

      assert.equal(result.text, "done");
    });
  });

  test("lmstudio uses native chat endpoint when tools are absent and thinking is disabled", async () => {
    const config = createLlmTestConfig({
      provider: "test",
      supportsVision: true,
      apiParameters: {
        temperature: 0.55,
        top_p: 0.75,
        top_k: 20,
        min_p: 0.01,
        presence_penalty: 0.1,
        repetition_penalty: 1.05,
        extra: {
          max_output_tokens: 96,
          store: true,
          previous_response_id: "resp_previous"
        }
      }
    });
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/api/v1/chat");
          assert.equal(body.reasoning, "off");
          assert.equal(body.stream, true);
          assert.equal(body.store, true);
          assert.equal(body.temperature, 0.55);
          assert.equal(body.top_p, 0.75);
          assert.equal(body.top_k, 20);
          assert.equal(body.min_p, 0.01);
          assert.equal(body.presence_penalty, 0.1);
          assert.equal(body.repeat_penalty, 1.05);
          assert.equal("repetition_penalty" in body, false);
          assert.equal(body.max_output_tokens, 96);
          assert.equal(body.previous_response_id, "resp_previous");
          assert.equal(body.system_prompt, "system prompt");
          assert.deepEqual(body.input, [
            { type: "text", content: "describe this image" },
            { type: "image", data_url: "data:image/png;base64,AAAA" }
          ]);
          assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-key");
        },
        response: createNativeLmStudioSseResponse([
          { type: "message.start" },
          { type: "message.delta", content: "一只" },
          { type: "message.delta", content: "猫" },
          { type: "message.end" },
          {
            type: "chat.end",
            result: {
              output: [{
                type: "message",
                content: "一只猫"
              }],
              stats: {
                input_tokens: 8,
                total_output_tokens: 3,
                reasoning_output_tokens: 0
              },
              response_id: "resp_next"
            }
          }
        ])
      }
    ], async () => {
      const deltas: string[] = [];
      const result = await client.generate({
        messages: [
          { role: "system", content: "system prompt" },
          {
            role: "user",
            content: [
              { type: "text", text: "describe this image" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
            ]
          }
        ],
        enableThinkingOverride: false,
        preferNativeNoThinkingChatEndpoint: true,
        onTextDelta: (delta) => {
          deltas.push(delta);
        }
      });

      assert.equal(result.text, "一只猫");
      assert.equal(result.usage.inputTokens, 8);
      assert.equal(result.usage.outputTokens, 3);
      assert.equal(result.usage.reasoningTokens, 0);
      assert.deepEqual(deltas, ["一只", "猫"]);
    });
  });

  test("lmstudio automatically uses native no-thinking chat endpoint without explicit prefer flag", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/api/v1/chat");
          assert.equal(body.reasoning, "off");
          assert.equal(body.stream, true);
          assert.deepEqual(body.input, [{ type: "text", content: "hello" }]);
        },
        response: createNativeLmStudioSseResponse([
          { type: "message.delta", content: "done" },
          { type: "chat.end", result: { output: [{ type: "message", content: "done" }] } }
        ])
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }],
        enableThinkingOverride: false
      });

      assert.equal(result.text, "done");
    });
  });

  test("lmstudio native stream surfaces SSE error events", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(_body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/api/v1/chat");
        },
        response: createNativeLmStudioSseResponse([
          {
            type: "error",
            error: {
              message: "model failed",
              type: "invalid_request",
              code: "bad_request",
              param: "input"
            }
          }
        ])
      }
    ], async () => {
      await assert.rejects(
        () => client.generate({
          messages: [{ role: "user", content: "hello" }],
          enableThinkingOverride: false
        }),
        /LM Studio native stream error: model failed; type=invalid_request; code=bad_request; param=input/
      );
    });
  });

  test("lmstudio native stream accepts final-only responses as first response", async () => {
    const config = createLlmTestConfig();
    config.llm.firstTokenTimeoutMs = 10;
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(_body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/api/v1/chat");
        },
        response: createNativeLmStudioSseResponse([
          { type: "chat.end", result: { output: [{ type: "message", content: "final text" }] } }
        ])
      }
    ], async () => {
      const deltas: string[] = [];
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }],
        enableThinkingOverride: false,
        onTextDelta: (delta) => {
          deltas.push(delta);
        }
      });

      assert.equal(result.text, "final text");
      assert.deepEqual(deltas, ["final text"]);
    });
  });

  test("lmstudio keeps openai-compatible chat completions when model thinking is not controllable", async () => {
    const config = createLlmTestConfig({
      thinkingControllable: false
    });
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/v1/chat/completions");
          assert.equal("enable_thinking" in body, false);
          assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
        },
        payloads: [{
          choices: [{
            delta: {
              content: "done"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }],
        enableThinkingOverride: false
      });

      assert.equal(result.text, "done");
    });
  });

  test("lmstudio flattens text-only content parts for openai-compatible chat completions", async () => {
    const config = createLlmTestConfig({
      thinkingControllable: false
    });
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/v1/chat/completions");
          assert.deepEqual(body.messages, [{
            role: "user",
            content: "我想想"
          }]);
        },
        payloads: [{
          choices: [{
            delta: {
              content: "done"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{
          role: "user",
          content: [{ type: "text", text: "我想想" }]
        }],
        enableThinkingOverride: false
      });

      assert.equal(result.text, "done");
    });
  });

  test("lmstudio preserves structured prompt tags for openai-compatible chat completions", async () => {
    const config = createLlmTestConfig({
      thinkingControllable: false
    });
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    const content = [
      "能看到我发给你的文档吗",
      buildTag("file", { file_id: "077a6286", name: "铅毒之果.pdf", download_tool: "download_message_file" })
    ].join("\n");

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/v1/chat/completions");
          assert.deepEqual(body.messages, [{
            role: "user",
            content
          }]);
        },
        payloads: [{
          choices: [{
            delta: {
              content: "done"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content }],
        enableThinkingOverride: false
      });

      assert.equal(result.text, "done");
    });
  });

  test("lmstudio retries without tools when template reports no user query", async () => {
    const config = createLlmTestConfig({
      thinkingControllable: false
    });
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/v1/chat/completions");
          assert.equal(Array.isArray(body.tools), true);
          assert.equal(body.tools.length, 1);
        },
        response: new Response(JSON.stringify({
          error: {
            message: "Error rendering prompt with jinja template: \"No user query found in messages.\""
          }
        }), {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        })
      },
      {
        assertRequest(body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/v1/chat/completions");
          assert.equal("tools" in body, false);
        },
        payloads: [{
          choices: [{
            delta: {
              content: "fallback without tools"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "测试" }],
        tools: [createToolDefinition("lookup")],
        enableThinkingOverride: false
      });

      assert.equal(result.text, "fallback without tools");
    });
  });

  test("lmstudio injects placeholder user when first non-system message is assistant", async () => {
    const config = createLlmTestConfig({
      thinkingControllable: false
    });
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/v1/chat/completions");
          assert.deepEqual(body.messages, [
            { role: "system", content: "sys" },
            { role: "user", content: buildTag("placeholder", { kind: "bootstrap_user", note: "ignore_this_placeholder" }) },
            { role: "assistant", content: "历史助手首条" },
            { role: "user", content: "真正用户输入" }
          ]);
          assert.equal(body.tools.length, 1);
        },
        payloads: [{
          choices: [{
            delta: {
              content: "ok"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [
          { role: "system", content: "sys" },
          { role: "assistant", content: "历史助手首条" },
          { role: "user", content: "真正用户输入" }
        ],
        tools: [createToolDefinition("lookup")],
        enableThinkingOverride: false
      });

      assert.equal(result.text, "ok");
    });
  });

  test("google ai studio requests include configured harm block threshold", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "google";
    config.llm.providers.test!.harmBlockThreshold = "BLOCK_ONLY_HIGH";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.deepEqual(body.safetySettings, [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
          ]);
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [{ text: "done" }]
            }
          }],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6
          }
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }]
      });

      assert.equal(result.text, "done");
    });
  });

  test("google ai studio consumes text from unterminated trailing SSE events", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "google";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest() {},
        response: createUnterminatedSseResponse({
          candidates: [{
            content: {
              parts: [{ text: "trailing reply" }]
            },
            finishReason: "STOP"
          }],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 2,
            totalTokenCount: 7
          }
        })
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }]
      });

      assert.equal(result.text, "trailing reply");
    });
  });

  test("google ai studio surfaces streamed provider errors", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "google";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await assert.rejects(
      withMockFetch([
        {
          assertRequest() {},
          payloads: [{
            error: {
              message: "Resource has been exhausted",
              type: "new_api_error",
              code: "invalid_request"
            }
          }]
        }
      ], async () => {
        await client.generate({
          messages: [{ role: "user", content: "hello" }]
        });
      }),
      /Google AI Studio API stream error: Resource has been exhausted/
    );
  });

  test("google ai studio maps configured model api parameters to generation config", async () => {
    const config = createLlmTestConfig({
      apiParameters: {
        temperature: 0.4,
        top_p: 0.8,
        top_k: 16,
        min_p: 0.01,
        presence_penalty: 0.25,
        repetition_penalty: 1.2,
        extra: {
          maxOutputTokens: 64,
          frequencyPenalty: 0.3
        }
      }
    });
    config.llm.providers.test!.type = "google";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.generationConfig.temperature, 0.4);
          assert.equal(body.generationConfig.topP, 0.8);
          assert.equal(body.generationConfig.topK, 16);
          assert.equal(body.generationConfig.presencePenalty, 0.25);
          assert.equal(body.generationConfig.maxOutputTokens, 64);
          assert.equal(body.generationConfig.frequencyPenalty, 0.3);
          assert.equal("min_p" in body.generationConfig, false);
          assert.equal("repetition_penalty" in body.generationConfig, false);
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [{ text: "done" }]
            }
          }],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6
          }
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }]
      });

      assert.equal(result.text, "done");
    });
  });

  test("google ai studio normalizes composition branches in function schemas", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "google";
    const client = new LlmClient(config, pino({ level: "silent" }));
    const tool = createToolDefinition("terminal_key");
    tool.function.parameters = {
      type: "object",
      properties: {
        resource_id: { type: "string" },
        key: { type: "string" },
        keys: {
          type: "array",
          items: { type: "string" },
          minItems: 1
        }
      },
      required: ["resource_id"],
      anyOf: [
        { required: ["resource_id", "key"] },
        { required: ["resource_id", "keys", "missing_field"] }
      ],
      additionalProperties: false
    };

    await withMockFetch([
      {
        assertRequest(body: any) {
          const parameters = body.tools[0].functionDeclarations[0].parameters;
          assert.equal(parameters.additionalProperties, undefined);
          assert.deepEqual(parameters.required, ["resource_id"]);
          assert.equal(parameters.anyOf[0].type, "object");
          assert.equal(parameters.anyOf[1].type, "object");
          assert.deepEqual(Object.keys(parameters.anyOf[0].properties).sort(), ["key", "keys", "resource_id"]);
          assert.deepEqual(parameters.anyOf[0].required, ["resource_id", "key"]);
          assert.deepEqual(parameters.anyOf[1].required, ["resource_id", "keys"]);
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [{ text: "done" }]
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }],
        tools: [tool]
      });

      assert.equal(result.text, "done");
    });
  });

  test("google ai studio replays normalized assistant tool-call content metadata", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "google";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.contents.length, 1);
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [
                { text: "看看便知。\n\n看看便知。" },
                {
                  thoughtSignature: "sig-1",
                  functionCall: {
                    id: "tool-call-1",
                    name: "lookup",
                    args: { query: "test" }
                  }
                }
              ]
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          const assistantParts = body.contents[1].parts;
          assert.equal(assistantParts[0].text, "看看便知。");
          assert.equal(assistantParts[1].thoughtSignature, "sig-1");
          assert.equal(assistantParts[1].functionCall.id, "tool-call-1");
          assert.equal(assistantParts[1].functionCall.name, "lookup");
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [{ text: "final" }]
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "查一下" }],
        tools: [createToolDefinition("lookup")],
        resolveAssistantToolCallContent: () => "看看便知。",
        toolExecutor: async () => "{\"ok\":true}"
      });

      assert.equal(result.text, "final");
    });
  });

  test("google ai studio preserves duplicate explicit call IDs for atomic envelope rejection", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "google";
    config.llm.toolCallProtocolRecoveryMaxAttempts = 1;
    const client = new LlmClient(config, pino({ level: "silent" }));
    let executeCount = 0;
    let assistantToolCallCount = 0;

    await withMockFetch([{
      assertRequest() {},
      payloads: [{
        candidates: [{
          content: {
            parts: [
              {
                functionCall: {
                  id: "duplicate-call-id",
                  name: "lookup",
                  args: {}
                }
              },
              {
                functionCall: {
                  id: "duplicate-call-id",
                  name: "read_other",
                  args: {}
                }
              }
            ]
          }
        }]
      }]
    }], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "读取两项" }],
        tools: [createToolDefinition("lookup"), createToolDefinition("read_other")],
        toolExecutor: async () => {
          executeCount += 1;
          return "{}";
        },
        onAssistantToolCalls() {
          assistantToolCallCount += 1;
        }
      });

      assert.equal(executeCount, 0);
      assert.equal(assistantToolCallCount, 0);
      assert.deepEqual(result.finishReason, {
        kind: "tool_call_limit",
        maxIterations: 4,
        cause: "protocol_recovery",
        protocolRecoveries: 1
      });
      assert.deepEqual(result.providerCallUsages?.map((event) => event.phase), ["invalid_response"]);
    });
  });

  test("vertex ai requests use bearer auth and vertex publisher endpoint", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "vertex";
    config.llm.providers.test!.baseUrl = "https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/publishers/google";
    config.llm.providers.test!.apiKey = "vertex-access-token";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, init: RequestInit, url: string) {
          assert.equal(url, "https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/publishers/google/models/fake-model:streamGenerateContent?alt=sse");
          assert.equal((init.headers as Record<string, string>).Authorization, "Bearer vertex-access-token");
          assert.deepEqual(body.contents, [{
            role: "user",
            parts: [{ text: "hello" }]
          }]);
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [{ text: "done" }]
            }
          }],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6
          }
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }]
      });

      assert.equal(result.text, "done");
    });
  });

  test("vertex express requests use API key query string and express endpoint", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "vertex_express";
    delete config.llm.providers.test!.baseUrl;
    config.llm.providers.test!.apiKey = "vertex-express-key";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, init: RequestInit, url: string) {
          assert.equal(url, "https://aiplatform.googleapis.com/v1/publishers/google/models/fake-model:streamGenerateContent?alt=sse&key=vertex-express-key");
          assert.equal((init.headers as Record<string, string>).Authorization, undefined);
          assert.deepEqual(body.contents, [{
            role: "user",
            parts: [{ text: "hello" }]
          }]);
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [{ text: "done" }]
            }
          }],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6
          }
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }]
      });

      assert.equal(result.text, "done");
    });
  });

  test("vertex express omits function part ids in replayed tool history", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "vertex_express";
    delete config.llm.providers.test!.baseUrl;
    config.llm.providers.test!.apiKey = "vertex-express-key";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          const assistantParts = body.contents[1].parts;
          const toolParts = body.contents[2].parts;
          assert.equal(assistantParts[0].functionCall.id, undefined);
          assert.equal(toolParts[0].functionResponse.id, undefined);
          assert.equal(assistantParts[0].functionCall.name, "lookup");
          assert.equal(toolParts[0].functionResponse.name, "lookup");
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [{ text: "done" }]
            }
          }],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6
          }
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [
          { role: "user", content: "continue the task" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "tool-call-1",
              type: "function",
              function: {
                name: "lookup",
                arguments: "{\"query\":\"test\"}"
              },
              providerMetadata: {
                google: {
                  thoughtSignature: "sig-1"
                }
              }
            }]
          },
          {
            role: "tool",
            tool_call_id: "tool-call-1",
            content: "{\"ok\":true}"
          }
        ]
      });

      assert.equal(result.text, "done");
    });
  });

  test("vertex express strips function part ids from replayed google parts metadata", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "vertex_express";
    delete config.llm.providers.test!.baseUrl;
    config.llm.providers.test!.apiKey = "vertex-express-key";
    const client = new LlmClient(config, pino({ level: "silent" }));
    const messages = createAssistantToolRoundtripMessages();
    const assistantMessage = messages[1]!;
    assert.equal(assistantMessage.role, "assistant");
    assistantMessage.providerMetadata = {
      googleParts: [{
        thoughtSignature: "sig-1",
        functionCall: {
          id: "tool-call-1",
          name: "lookup",
          args: { query: "test" }
        }
      }]
    };
    assistantMessage.tool_calls![0]!.providerMetadata = {
      google: {
        thoughtSignature: "sig-1"
      }
    };

    await withMockFetch([
      {
        assertRequest(body: any) {
          const assistantParts = body.contents[1].parts;
          const toolParts = body.contents[2].parts;
          assert.equal(assistantParts[0].functionCall.id, undefined);
          assert.equal(assistantParts[0].functionCall.name, "lookup");
          assert.equal(assistantParts[0].thoughtSignature, "sig-1");
          assert.equal(toolParts[0].functionResponse.id, undefined);
          assert.equal(toolParts[0].functionResponse.name, "lookup");
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [{ text: "done" }]
            }
          }],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6
          }
        }]
      }
    ], async () => {
      const result = await client.generate({ messages });
      assert.equal(result.text, "done");
    });
  });

  test("vertex express passes tool history through without thoughtSignature when thinking is off", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "vertex_express";
    delete config.llm.providers.test!.baseUrl;
    config.llm.providers.test!.apiKey = "vertex-express-key";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          // thinking OFF: tool history rebuilt from tool_calls without thoughtSignature or part ids
          assert.equal(body.contents.length, 3);
          assert.equal(body.contents[0]?.role, "user");
          assert.equal(body.contents[1]?.role, "model");
          assert.ok(body.contents[1]?.parts?.[0]?.functionCall?.name === "lookup");
          assert.equal(body.contents[1]?.parts?.[0]?.functionCall?.id, undefined); // vertex_express strips ids
          assert.equal(body.contents[2]?.role, "user");
          assert.ok(body.contents[2]?.parts?.[0]?.functionResponse?.name === "lookup");
          assert.equal(body.contents[2]?.parts?.[0]?.functionResponse?.id, undefined); // vertex_express strips ids
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [{ text: "done" }]
            }
          }],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6
          }
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: createAssistantToolRoundtripMessages()
      });
      assert.equal(result.text, "done");
    });
  });

  test("google ai studio drops invalid replayed tool chains that are not preceded by a user or tool turn", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "google";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.contents.length, 2);
          assert.equal(body.contents[0]?.role, "model");
          assert.deepEqual(body.contents[0]?.parts, [{ text: "上轮已经总结过了" }]);
          assert.equal(body.contents[1]?.role, "user");
          assert.deepEqual(body.contents[1]?.parts, [{ text: "继续" }]);
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [{ text: "done" }]
            }
          }],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6
          }
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [
          {
            role: "assistant",
            content: "上轮已经总结过了"
          },
          {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "tool-call-invalid-1",
              type: "function",
              function: {
                name: "lookup",
                arguments: "{\"query\":\"test\"}"
              },
              providerMetadata: {
                google: {
                  thoughtSignature: "sig-invalid-1"
                }
              }
            }],
            providerMetadata: {
              googleParts: [{
                thoughtSignature: "sig-invalid-1",
                functionCall: {
                  id: "tool-call-invalid-1",
                  name: "lookup",
                  args: { query: "test" }
                }
              }]
            }
          },
          {
            role: "tool",
            tool_call_id: "tool-call-invalid-1",
            content: "{\"ok\":true}"
          },
          {
            role: "user",
            content: "继续"
          }
        ]
      });

      assert.equal(result.text, "done");
    });
  });

  test("openai-compatible requests explicitly convert multimodal content parts", async () => {
    const client = new LlmClient(createLlmTestConfig({
      supportsVision: true,
      supportsAudioInput: true
    }), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
          assert.deepEqual(body.messages[0], {
            role: "user",
            content: [
              {
                type: "text",
                text: "describe these"
              },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/png;base64,AAAA"
                }
              },
              {
                type: "input_audio",
                input_audio: {
                  data: "ZmFrZQ==",
                  format: "mp3"
                }
              }
            ]
          });
        },
        payloads: [{
          choices: [{
            delta: {
              content: "done"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: "describe these"
            },
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,AAAA"
              }
            },
            {
              type: "input_audio",
              input_audio: {
                data: "ZmFrZQ==",
                format: "mp3",
                mimeType: "audio/mpeg"
              }
            }
          ]
        }]
      });

      assert.equal(result.text, "done");
    });
  });
