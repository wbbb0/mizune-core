import test from "node:test";
import assert from "node:assert/strict";
import { setFetchImplementationForTests } from "#services/proxy/index.ts";
import { createInternalApiApp, createInternalApiDeps } from "../helpers/internal-api-fixtures.tsx";
import { createSseResponse } from "../helpers/llm-test-support.tsx";

const payload = { provider: { type: "openai_compatible", baseUrl: "https://probe.example/v1", apiKey: "draft-key" }, model: { upstreamModel: "draft-model" }, operation: "chat" };

test("model test route validates input and uses a draft model without saving or reloading configuration", async () => {
  const deps = createInternalApiDeps();
  let calls = 0;
  const original = structuredClone(deps.config);
  const app = await createInternalApiApp(deps);
  setFetchImplementationForTests(async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init!.body)).model, "draft-model");
    return createSseResponse([{ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] }]);
  });
  try {
    for (const body of [{ ...payload, operation: "unknown" }, { ...payload, model: {} }, { ...payload, extra: "unexpected" }]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/editors/llm_catalog/test-model", payload: body })).statusCode, 400);
    }
    assert.equal(calls, 0);
    const response = await app.inject({ method: "POST", url: "/api/editors/llm_catalog/test-model", payload });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal(result.operation, "chat");
    assert.equal(result.status, "passed");
    assert.equal(calls, 1);
    assert.deepEqual(deps.config, original);
    assert.doesNotMatch(response.body, /draft-key|draft-model/);
  } finally { setFetchImplementationForTests(null); await app.close(); }
});

test("model test route rejects a concurrent request with HTTP 409", async () => {
  const deps = createInternalApiDeps();
  const app = await createInternalApiApp(deps);
  let reached!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  setFetchImplementationForTests(async () => {
    calls++;
    reached();
    await gate;
    return createSseResponse([{ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] }]);
  });
  try {
    const first = app.inject({ method: "POST", url: "/api/editors/llm_catalog/test-model", payload });
    await started;
    const second = await app.inject({ method: "POST", url: "/api/editors/llm_catalog/test-model", payload });
    assert.equal(second.statusCode, 409);
    assert.equal(calls, 1);
    release();
    assert.equal((await first).json().status, "passed");
  } finally { release(); setFetchImplementationForTests(null); await app.close(); }
});

test("closing an HTTP model test aborts its upstream request and releases the probe slot", async () => {
  const app = await createInternalApiApp(createInternalApiDeps());
  let reached!: () => void;
  let aborted!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  setFetchImplementationForTests(async (_url, init) => {
    reached();
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted(); reject(new Error("upstream cancelled")); }, { once: true });
    });
  });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 3000);
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = fetch(`${address}/api/editors/llm_catalog/test-model`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
    await Promise.race([started, request.then(() => { throw new Error("测试请求未到达上游"); })]);
    controller.abort();
    await assert.rejects(request, /abort/i);
    await cancelled;
    // Allow the adapter rejection and its finally to release the slot before the next request.
    await new Promise(resolve => setImmediate(resolve));
    setFetchImplementationForTests(async () => createSseResponse([{ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] }]));
    const next = await app.inject({ method: "POST", url: "/api/editors/llm_catalog/test-model", payload });
    assert.equal(next.statusCode, 200);
    assert.equal(next.json().status, "passed");
  } finally { clearTimeout(deadline); controller.abort(); setFetchImplementationForTests(null); await app.close(); }
});
