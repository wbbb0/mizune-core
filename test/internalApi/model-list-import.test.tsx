import test from "node:test";
import assert from "node:assert/strict";
import { setFetchImplementationForTests } from "#services/proxy/index.ts";
import { createInternalApiApp, createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";

const OPENAI_LIST_PAYLOAD = {
  object: "list",
  data: [
    { id: "gpt-4o", object: "model", created: 1700000000, owned_by: "openai" },
    { id: "gpt-5.6", object: "model", created: 1700000001, owned_by: "openai" }
  ]
};

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("internal api lists provider models from the OpenAI-compatible endpoint", async () => {
  const deps = createInternalApiDeps();
  setFetchImplementationForTests(async (requestUrl, init) => {
    assert.equal(requestUrl, "https://example.com/v1/models");
    assert.equal((init?.headers as Record<string, string>)?.Authorization, "Bearer test-key");
    return makeResponse(OPENAI_LIST_PAYLOAD);
  });
  const app = await createInternalApiApp(deps);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/editors/llm_catalog/list-models",
      payload: {
        provider: { type: "openai", baseUrl: "https://example.com/v1", apiKey: "test-key" }
      }
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.kind, "ok");
    assert.equal(body.endpoint, "https://example.com/v1/models");
    assert.deepEqual(
      body.models.map((slot: { upstreamModel: string; alias: string }) => [slot.upstreamModel, slot.alias]),
      [["gpt-4o", "gpt_4o"], ["gpt-5.6", "gpt_5_6"]]
    );
    assert.equal(body.models[0].capabilities.modelType, "chat");
    assert.equal(body.models[0].capabilities.supportsSearch, false);
  } finally {
    setFetchImplementationForTests(null);
    await app.close();
  }
});

test("internal api marks upstream models already present in the provider draft", async () => {
  const deps = createInternalApiDeps();
  setFetchImplementationForTests(async () => makeResponse(OPENAI_LIST_PAYLOAD));
  const app = await createInternalApiApp(deps);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/editors/llm_catalog/list-models",
      payload: {
        provider: {
          type: "openai",
          baseUrl: "https://example.com/v1",
          models: {
            main: { upstreamModel: "gpt-4o" }
          }
        }
      }
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.kind, "ok");
    const existing = body.models.find((slot: { upstreamModel: string }) => slot.upstreamModel === "gpt-4o");
    assert.equal(existing.exists, true);
    assert.equal(existing.alias, "main");
    const fresh = body.models.find((slot: { upstreamModel: string }) => slot.upstreamModel === "gpt-5.6");
    assert.equal(fresh.exists, false);
    assert.equal(fresh.alias, "gpt_5_6");
  } finally {
    setFetchImplementationForTests(null);
    await app.close();
  }
});

test("internal api reports unsupported provider types without hitting the network", async () => {
  const deps = createInternalApiDeps();
  let fetchCalled = false;
  setFetchImplementationForTests(async () => {
    fetchCalled = true;
    return makeResponse(OPENAI_LIST_PAYLOAD);
  });
  const app = await createInternalApiApp(deps);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/editors/llm_catalog/list-models",
      payload: {
        provider: { type: "vertex", projectId: "demo" }
      }
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.kind, "unsupported");
    assert.match(body.reason, /暂不支持/);
    assert.equal(fetchCalled, false);
  } finally {
    setFetchImplementationForTests(null);
    await app.close();
  }
});

test("internal api surfaces upstream list errors as bad requests", async () => {
  const deps = createInternalApiDeps();
  setFetchImplementationForTests(async () => new Response("{\"error\":{\"code\":\"invalid_api_key\"}}", {
    status: 401,
    statusText: "Unauthorized",
    headers: { "Content-Type": "application/json" }
  }));
  const app = await createInternalApiApp(deps);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/editors/llm_catalog/list-models",
      payload: {
        provider: { type: "deepseek", apiKey: "bad-key" }
      }
    });
    assert.equal(response.statusCode, 400);
    const body = response.json();
    assert.match(body.error, /401/);
  } finally {
    setFetchImplementationForTests(null);
    await app.close();
  }
});