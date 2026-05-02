import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";
import { withMockFetch } from "../../helpers/llm-test-support.tsx";

test("LlmClient sends embedding requests through embedding model routing", async () => {
  const config = createTestAppConfig({
    llm: {
      enabled: true,
      providers: {
        test: {
          type: "openai",
          baseUrl: "https://example.com/v1",
          apiKey: "embedding-key",
          proxy: false
        }
      },
      models: {
        embedding: {
          provider: "test",
          model: "text-embedding-test",
          modelType: "embedding",
          supportsTools: false
        }
      },
      routingPresets: {
        test: {
          embedding: ["embedding"]
        }
      }
    }
  });
  const client = new LlmClient(config, pino({ level: "silent" }));

  await withMockFetch([
    {
      assertRequest(body: any, _callIndex: number, init: any, url: string) {
        assert.equal(url, "https://example.com/v1/embeddings");
        assert.equal(init.headers.Authorization, "Bearer embedding-key");
        assert.equal(body.model, "text-embedding-test");
        assert.deepEqual(body.input, ["hello", "world"]);
      },
      response: new Response(JSON.stringify({
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 1, embedding: [0, 1] }
        ],
        usage: {
          prompt_tokens: 2,
          total_tokens: 2
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    }
  ], async () => {
    const result = await client.embedTexts({
      texts: ["hello", "world"]
    });

    assert.equal(result.modelRef, "embedding");
    assert.equal(result.model, "text-embedding-test");
    assert.deepEqual(result.vectors, [[1, 0], [0, 1]]);
    assert.equal(result.usage.inputTokens, 2);
  });
});
