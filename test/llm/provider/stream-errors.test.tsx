import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import { createLlmTestConfig, withMockFetch } from "../../helpers/llm-test-support.tsx";

for (const scenario of [
  { name: "SSE upstream error", raw: 'data: {"error":{"code":429,"message":"quota exceeded"}}\n\n', match: /429 quota exceeded/ },
  { name: "error after partial text", raw: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"code":500,"message":"upstream failed"}}\n\n', match: /500 upstream failed/ },
  { name: "JSON error with HTTP 200", raw: '{"error":{"code":429,"message":"quota exceeded"}}', match: /429 quota exceeded/, contentType: "application/json" },
  { name: "JSON error mislabeled as SSE", raw: '{"error":{"message":"upstream failed"}}', match: /upstream failed/ },
  { name: "refusal", raw: 'data: {"choices":[{"delta":{"refusal":"request refused"}}]}\n\n', match: /provider refusal: request refused/ },
  { name: "content filter after partial text", raw: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n', match: /content_filter/ }
]) {
  test(`OpenAI preserves ${scenario.name} instead of returning empty or partial success`, async () => {
    const config = createLlmTestConfig();
    const client = new LlmClient(config, pino({ level: "silent" }));
    const deltas: string[] = [];
    await withMockFetch([{
      assertRequest() {},
      response: new Response(scenario.raw, { headers: { "content-type": scenario.contentType ?? "text/event-stream" } })
    }], async () => {
      await assert.rejects(client.generate({ messages: [{ role: "user", content: "ping" }], skipDebugDump: true, onTextDelta: delta => { deltas.push(delta); } }), scenario.match);
      assert.deepEqual(deltas, []);
    });
  });
}

test("OpenAI consumes multiline data and final SSE event without blank delimiter", async () => {
  const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
  await withMockFetch([{
    assertRequest() {},
    response: new Response('data: {"choices":\ndata: [{"delta":{"content":"最后一段"},"finish_reason":"stop"}]}', { headers: { "content-type": "text/event-stream" } })
  }], async () => {
    const result = await client.generate({ messages: [{ role: "user", content: "ping" }], skipDebugDump: true });
    assert.equal(result.text, "最后一段");
  });
});

test("OpenAI empty response includes upstream completion metadata", async () => {
  const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
  await withMockFetch([{
    assertRequest() {},
    payloads: [{ id: "gen-empty", provider: "example", choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { completion_tokens: 49 } }]
  }], async () => {
    await assert.rejects(client.generate({ messages: [{ role: "user", content: "ping" }], skipDebugDump: true }), /finish_reason=stop, provider=example, response_id=gen-empty, output_tokens=49/);
  });
});

test("Google malformed SSE after partial text fails instead of completing", async () => {
  const config = createLlmTestConfig();
  config.llm.providers.test!.type = "google";
  const deltas: string[] = [];
  await withMockFetch([{
    assertRequest() {},
    response: new Response('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\ndata: {broken json}\n\n', { headers: { "content-type": "text/event-stream" } })
  }], async () => {
    await assert.rejects(new LlmClient(config, pino({ level: "silent" })).generate({
      messages: [{ role: "user", content: "ping" }], skipDebugDump: true,
      onTextDelta: delta => { deltas.push(delta); }
    }), SyntaxError);
    assert.deepEqual(deltas, []);
  });
});

for (const delta of [{ refusal: "I cannot assist with that request." }, {}]) {
  test(`policy response still falls back to the next model (${JSON.stringify(delta)})`, async () => {
    const config = createLlmTestConfig([{ model: "first" }, { model: "second" }]);
    await withMockFetch([
      { assertRequest() {}, payloads: [{ choices: [{ delta, finish_reason: "refusal" in delta ? "stop" : "content_filter" }] }] },
      { assertRequest(body: any) { assert.equal(body.model, "second"); }, payloads: [{ choices: [{ delta: { content: "fallback" } }] }] }
    ], async () => {
      const result = await new LlmClient(config, pino({ level: "silent" })).generate({ messages: [{ role: "user", content: "ping" }], skipDebugDump: true });
      assert.equal(result.text, "fallback");
    });
  });
}

test("provisional text arrives before completion and resets without committing failed text", async () => {
  const release = deferred();
  const previewReceived = deferred();
  const previews: string[] = [];
  const committed: string[] = [];
  let resets = 0;
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({ async start(controller) {
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"preview"}}]}\n\n'));
    await release.promise;
    controller.enqueue(encoder.encode('data: {"error":{"code":500,"message":"failed"}}\n\n'));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
  await withMockFetch([{ assertRequest() {}, response }], async () => {
    const running = new LlmClient(createLlmTestConfig(), pino({ level: "silent" })).generate({
      messages: [{ role: "user", content: "synthetic test" }], skipDebugDump: true,
      onPreviewTextDelta(delta) { previews.push(delta); previewReceived.resolve(); },
      onPreviewReset() { resets++; }, onTextDelta(delta) { committed.push(delta); }
    });
    const rejected = assert.rejects(running, /500 failed/);
    try {
      await Promise.race([previewReceived.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("no live preview")), 1000))]);
      assert.deepEqual(previews, ["preview"]);
      assert.deepEqual(committed, []);
    } finally { release.resolve(); }
    await rejected;
    assert.equal(resets, 1);
    assert.deepEqual(committed, []);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
