import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import { createAssistantToolRoundtripMessages, createLlmTestConfig, createToolDefinition, withMockFetch } from "../../helpers/llm-test-support.tsx";

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
      supportsVision: true
    });
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/api/v1/chat");
          assert.equal(body.reasoning, "off");
          assert.equal(body.stream, false);
          assert.equal(body.store, false);
          assert.equal(body.system_prompt, "system prompt");
          assert.deepEqual(body.input, [
            { type: "message", content: "describe this image" },
            { type: "image", data_url: "data:image/png;base64,AAAA" }
          ]);
          assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-key");
        },
        response: new Response(JSON.stringify({
          output: [{
            type: "message",
            content: "一只猫"
          }],
          stats: {
            input_tokens: 8,
            total_output_tokens: 3,
            reasoning_output_tokens: 0
          }
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      }
    ], async () => {
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
        preferNativeNoThinkingChatEndpoint: true
      });

      assert.equal(result.text, "一只猫");
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
          assert.deepEqual(body.input, [{ type: "message", content: "hello" }]);
        },
        response: new Response(JSON.stringify({
          output: [{
            type: "message",
            content: "done"
          }]
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }],
        enableThinkingOverride: false
      });

      assert.equal(result.text, "done");
    });
  });

  test("lmstudio retries with text+content native shape when server requires text discriminator", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/api/v1/chat");
          assert.deepEqual(body.input, [{ type: "message", content: "hello" }]);
        },
        response: new Response(JSON.stringify({
          error: {
            message: "Invalid discriminator value. Expected 'text' | 'image'"
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
          assert.equal(url, "http://localhost:1234/api/v1/chat");
          assert.deepEqual(body.input, [{ type: "text", content: "hello" }]);
        },
        response: new Response(JSON.stringify({
          output: [{
            type: "message",
            content: "fallback ok"
          }]
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }],
        enableThinkingOverride: false
      });

      assert.equal(result.text, "fallback ok");
    });
  });

  test("lmstudio retries with legacy text+text shape after text+content fallback fails", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/api/v1/chat");
          assert.deepEqual(body.input, [{ type: "message", content: "hello" }]);
        },
        response: new Response(JSON.stringify({
          error: {
            message: "Invalid discriminator value. Expected 'text' | 'image'"
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
          assert.equal(url, "http://localhost:1234/api/v1/chat");
          assert.deepEqual(body.input, [{ type: "text", content: "hello" }]);
        },
        response: new Response(JSON.stringify({
          error: {
            message: "'input.0.text' is required, Unrecognized key(s) in object: 'content'"
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
          assert.equal(url, "http://localhost:1234/api/v1/chat");
          assert.deepEqual(body.input, [{ type: "text", text: "hello" }]);
        },
        response: new Response(JSON.stringify({
          output: [{
            type: "message",
            content: "legacy ok"
          }]
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "hello" }],
        enableThinkingOverride: false
      });

      assert.equal(result.text, "legacy ok");
    });
  });

  test("lmstudio does not retry with legacy shape when server requires content field", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/api/v1/chat");
          assert.deepEqual(body.input, [{ type: "message", content: "hello" }]);
        },
        response: new Response(JSON.stringify({
          error: {
            message: "'input.0.content' is required, Unrecognized key(s) in object: 'text'"
          }
        }), {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        })
      }
    ], async () => {
      await assert.rejects(
        () => client.generate({
          messages: [{ role: "user", content: "hello" }],
          enableThinkingOverride: false
        }),
        /input\.0\.content/
      );
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
            { role: "user", content: "⟦placeholder kind=\"bootstrap_user\" note=\"ignore_this_placeholder\"⟧" },
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
