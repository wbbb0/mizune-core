import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";
import { createAssistantToolRoundtripMessages, createLlmTestConfig, createToolCallPayload, createToolDefinition, withMockFetch } from "../../helpers/llm-test-support.tsx";

  test("google ai studio passes tool history through without thoughtSignature when thinking is off", async () => {
    const config = createTestAppConfig({
      llm: {
        enabled: true,
        providers: {
          googleTest: {
            type: "google",
            apiKey: "google-key",
            proxy: false,
            harmBlockThreshold: "BLOCK_NONE"
          }
        },
        models: {
          main: {
            provider: "googleTest",
            model: "gemini-test",
            supportsThinking: true,
            supportsVision: false,
            supportsAudioInput: false,
            supportsSearch: false,
            supportsTools: true,
            preserveThinking: false
          }
        }
      }
    });
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          // thinking OFF: tool history is rebuilt from tool_calls without thoughtSignature
          assert.equal(body.contents.length, 3);
          assert.equal(body.contents[0]?.role, "user");
          assert.equal(body.contents[1]?.role, "model");
          assert.ok(body.contents[1]?.parts?.[0]?.functionCall?.name === "lookup");
          assert.equal(body.contents[2]?.role, "user");
          assert.ok(body.contents[2]?.parts?.[0]?.functionResponse?.name === "lookup");
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [{ text: "google passthrough reply" }]
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

      assert.equal(result.text, "google passthrough reply");
    });
  });

  test("google ai studio skips tool history without thoughtSignature when thinking is on", async () => {
    const config = createTestAppConfig({
      llm: {
        enabled: true,
        providers: {
          googleTest: {
            type: "google",
            apiKey: "google-key",
            proxy: false,
            harmBlockThreshold: "BLOCK_NONE"
          }
        },
        models: {
          main: {
            provider: "googleTest",
            model: "gemini-test",
            supportsThinking: true,
            supportsVision: false,
            supportsAudioInput: false,
            supportsSearch: false,
            supportsTools: true,
            preserveThinking: false
          }
        }
      }
    });
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          // thinking ON + no thoughtSignature: tool call chain is silently skipped
          assert.equal(body.contents.length, 1);
          assert.equal(body.contents[0]?.role, "user");
        },
        payloads: [{
          candidates: [{
            content: {
              parts: [{ text: "google skipped reply" }]
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
        messages: createAssistantToolRoundtripMessages(),
        enableThinkingOverride: true
      });

      assert.equal(result.text, "google skipped reply");
    });
  });

  test("provider fallback stays sticky for the rest of one tool orchestration", async () => {
    const client = new LlmClient(createLlmTestConfig([
      {
        provider: "test",
        model: "primary-model",
        supportsThinking: true,
        supportsTools: true
      },
      {
        provider: "test",
        model: "fallback-model",
        supportsThinking: true,
        supportsTools: true
      }
    ]), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.model, "primary-model");
          assert.equal(body.messages.length, 1);
        },
        error: new Error("503 Service Unavailable")
      },
      {
        assertRequest(body: any) {
          assert.equal(body.model, "fallback-model");
          assert.equal(body.messages.length, 1);
        },
        payloads: createToolCallPayload("fallback-round")
      },
      {
        assertRequest(body: any) {
          assert.equal(body.model, "fallback-model");
          assert.equal(body.messages.length, 3);
          assert.equal(body.messages[1].role, "assistant");
          assert.equal(body.messages[2].role, "tool");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "sticky fallback worked"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "do the thing" }],
        tools: [createToolDefinition("lookup")],
        toolExecutor: async () => "{\"ok\":true}"
      });

      assert.equal(result.text, "sticky fallback worked");
    });
  });

  test("provider fallback emits structured fallback events", async () => {
    const client = new LlmClient(createLlmTestConfig([
      {
        provider: "test",
        model: "primary-model"
      },
      {
        provider: "test",
        model: "secondary-model"
      }
    ]), pino({ level: "silent" }));
    const fallbackEvents: Array<{
      summary: string;
      details: string;
      fromModelRef: string;
      toModelRef: string;
      fromProvider: string;
      toProvider: string;
    }> = [];

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.model, "primary-model");
        },
        error: new Error("503 Service Unavailable")
      },
      {
        assertRequest(body: any) {
          assert.equal(body.model, "secondary-model");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "fallback worked"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "do the thing" }],
        onFallbackEvent(event) {
          fallbackEvents.push(event);
        }
      });

      assert.equal(result.text, "fallback worked");
    });

    assert.equal(fallbackEvents.length, 1);
    assert.equal(fallbackEvents[0]?.fromModelRef, "main");
    assert.equal(fallbackEvents[0]?.toModelRef, "candidate_2");
    assert.equal(fallbackEvents[0]?.fromProvider, "test");
    assert.equal(fallbackEvents[0]?.toProvider, "test");
    assert.match(fallbackEvents[0]?.summary ?? "", /已切换到/);
    assert.match(fallbackEvents[0]?.details ?? "", /503 Service Unavailable/);
  });

  test("temporarily unavailable candidate falls back to the next model in the list", async () => {
    const client = new LlmClient(createLlmTestConfig([
      {
        provider: "test",
        model: "primary-model"
      },
      {
        provider: "test",
        model: "secondary-model"
      }
    ]), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.model, "primary-model");
        },
        response: new Response(
          JSON.stringify({ error: "temporarily unavailable" }),
          {
            status: 503,
            statusText: "Service Unavailable",
            headers: { "Content-Type": "application/json" }
          }
        )
      },
      {
        assertRequest(body: any) {
          assert.equal(body.model, "secondary-model");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "fallback worked"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "ping" }]
      });

      assert.equal(result.text, "fallback worked");
    });
  });

  test("google missing thought signature request shape falls back to the next model", async () => {
    const config = createTestAppConfig({
      llm: {
        enabled: true,
        routingPresets: {
          test: {
            mainSmall: ["main", "fallback"],
            mainLarge: ["main", "fallback"],
            summarizer: ["main"],
            sessionCaptioner: ["sessionCaptioner"],
            imageCaptioner: ["main"],
            audioTranscription: ["transcription"],
            turnPlanner: ["main"]
          }
        },
        providers: {
          googleTest: {
            type: "google",
            apiKey: "google-key",
            proxy: false,
            harmBlockThreshold: "BLOCK_NONE"
          },
          fallbackTest: {
            type: "openai",
            apiKey: "fallback-key",
            proxy: false,
            baseUrl: "https://fallback.example.invalid/v1"
          }
        },
        models: {
          main: {
            provider: "googleTest",
            model: "gemini-test",
            supportsThinking: true,
            supportsVision: false,
            supportsAudioInput: false,
            supportsSearch: false,
            supportsTools: true,
            preserveThinking: false
          },
          fallback: {
            provider: "fallbackTest",
            model: "fallback-model",
            supportsThinking: true,
            supportsVision: false,
            supportsAudioInput: false,
            supportsSearch: false,
            supportsTools: true,
            preserveThinking: false
          }
        }
      }
    });
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.contents[0]?.role, "user");
        },
        response: new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly.",
              status: "INVALID_ARGUMENT"
            }
          }),
          {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json" }
          }
        )
      },
      {
        assertRequest(body: any) {
          assert.equal(body.model, "fallback-model");
          assert.equal(body.messages.length, 1);
          assert.equal(body.messages[0]?.role, "user");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "fallback after google request-shape error"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "继续" }],
        enableThinkingOverride: true
      });

      assert.equal(result.text, "fallback after google request-shape error");
    });
  });

  test("empty-content candidate falls back to the next model in the list", async () => {
    const client = new LlmClient(createLlmTestConfig([
      {
        provider: "test",
        model: "primary-model"
      },
      {
        provider: "test",
        model: "secondary-model"
      }
    ]), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.model, "primary-model");
        },
        payloads: [{
          usage: {
            prompt_tokens: 7,
            completion_tokens: 0,
            total_tokens: 7
          }
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.model, "secondary-model");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "fallback after empty content"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "ping" }]
      });

      assert.equal(result.text, "fallback after empty content");
    });
  });

  test("policy-blocked candidate falls back to the next model in the list", async () => {
    const client = new LlmClient(createLlmTestConfig([
      {
        provider: "test",
        model: "primary-model"
      },
      {
        provider: "test",
        model: "secondary-model"
      }
    ]), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.model, "primary-model");
        },
        response: new Response(
          JSON.stringify({
            error: {
              type: "safety_block",
              message: "Request blocked by safety policy"
            }
          }),
          {
            status: 403,
            statusText: "Forbidden",
            headers: { "Content-Type": "application/json" }
          }
        )
      },
      {
        assertRequest(body: any) {
          assert.equal(body.model, "secondary-model");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "fallback after policy block"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "ping" }]
      });

      assert.equal(result.text, "fallback after policy block");
    });
  });

  test("invalid-request candidate does not fall back to the next model", async () => {
    const client = new LlmClient(createLlmTestConfig([
      {
        provider: "test",
        model: "primary-model"
      },
      {
        provider: "test",
        model: "secondary-model"
      }
    ]), pino({ level: "silent" }));

    let sawSecondCandidate = false;

    await assert.rejects(async () => {
      await withMockFetch([
        {
          assertRequest(body: any) {
            assert.equal(body.model, "primary-model");
          },
          response: new Response(
            JSON.stringify({ error: "bad tool schema" }),
            {
              status: 400,
              statusText: "Bad Request",
              headers: { "Content-Type": "application/json" }
            }
          )
        },
        {
          assertRequest() {
            sawSecondCandidate = true;
          },
          payloads: []
        }
      ], async () => {
        await client.generate({
          messages: [{ role: "user", content: "ping" }]
        });
      });
    }, /bad tool schema/i);

    assert.equal(sawSecondCandidate, false);
  });
