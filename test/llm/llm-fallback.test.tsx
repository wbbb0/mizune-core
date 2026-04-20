import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function createConfig() {
  return createTestAppConfig({
    llm: {
      enabled: true,
      mainRouting: {
        smallModelRef: ["blocked_model", "fallback_model"],
        largeModelRef: ["blocked_model", "fallback_model"]
      },
      providers: {
        blocked_provider: {
          type: "openai",
          baseUrl: "https://example.com/v1",
          apiKey: "blocked-key",
          proxy: false
        },
        fallback_provider: {
          type: "openai",
          baseUrl: "https://example.com/v1",
          apiKey: "fallback-key",
          proxy: false
        }
      },
      models: {
        blocked_model: {
          provider: "blocked_provider",
          model: "blocked-model",
          supportsThinking: false,
          supportsVision: false,
          supportsSearch: false,
          supportsTools: false
        },
        fallback_model: {
          provider: "fallback_provider",
          model: "fallback-model",
          supportsThinking: false,
          supportsVision: false,
          supportsSearch: false,
          supportsTools: false
        }
      }
    },
    search: {
      googleGrounding: {
        enabled: false
      }
    },
    browser: {
      enabled: false
    }
  });
}

function createSseResponse(text: string) {
  const encoder = new TextEncoder();
  const raw = [
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          content: text
        }
      }]
    })}\n\n`,
    "data: [DONE]\n\n"
  ].join("");

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

  const client = new LlmClient(createConfig(), pino({ level: "silent" }));
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    callCount += 1;

    if (callCount === 1) {
      assert.equal(body.model, "blocked-model");
      return new Response(JSON.stringify({
        error: {
          code: "421",
          message: "Moderation Block",
          param: "The request was rejected because it was considered high risk",
          type: "content_filter"
        }
      }), {
        status: 400,
        statusText: "Bad Request",
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    assert.equal(callCount, 2);
    assert.equal(body.model, "fallback-model");
    return createSseResponse("fallback succeeded");
  };

  try {
    const result = await client.generate({
      messages: [{
        role: "user",
        content: "帮我看下 apt 可更新清单"
      }]
    });

    assert.equal(result.text, "fallback succeeded");
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
