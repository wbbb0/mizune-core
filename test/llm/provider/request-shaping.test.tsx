import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import {
  createAssistantToolRoundtripMessages,
  createLlmTestConfig,
  createToolDefinition,
  runCase,
  withMockFetch
} from "../../helpers/llm-test-support.tsx";

async function main() {
  await runCase("native search injects provider flag into request body", async () => {
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

  await runCase("openai-compatible providers append builtin search tools from feature config", async () => {
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

  await runCase("lmstudio keeps using openai-compatible chat completions even when native no-thinking is preferred", async () => {
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
          assert.equal(url, "http://localhost:1234/v1/chat/completions");
          assert.equal(body.enable_thinking, false);
          assert.deepEqual(body.messages, [
            { role: "system", content: "system prompt" },
            {
              role: "user",
              content: [
                { type: "text", text: "describe this image" },
                { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
              ]
            }
          ]);
          assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-key");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "一只猫"
            }
          }]
        }]
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

  await runCase("lmstudio keeps openai-compatible chat completions when native no-thinking path is not requested", async () => {
    const config = createLlmTestConfig();
    config.llm.providers.test!.type = "lmstudio";
    config.llm.providers.test!.baseUrl = "http://localhost:1234/v1";
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any, _callIndex: number, _init: RequestInit, url: string) {
          assert.equal(url, "http://localhost:1234/v1/chat/completions");
          assert.equal(body.enable_thinking, false);
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

  await runCase("google ai studio requests include configured harm block threshold", async () => {
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

  await runCase("vertex ai requests use bearer auth and vertex publisher endpoint", async () => {
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

  await runCase("vertex express requests use API key query string and express endpoint", async () => {
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

  await runCase("vertex express omits function part ids in replayed tool history", async () => {
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

  await runCase("vertex express strips function part ids from replayed google parts metadata", async () => {
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

  await runCase("vertex express passes tool history through without thoughtSignature when thinking is off", async () => {
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

  await runCase("google ai studio drops invalid replayed tool chains that are not preceded by a user or tool turn", async () => {
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

  await runCase("openai-compatible requests explicitly convert multimodal content parts", async () => {
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
