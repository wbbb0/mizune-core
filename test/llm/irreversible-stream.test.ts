import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { createLlmTestConfig, withMockFetch } from "../helpers/llm-test-support.tsx";

const event = (delta: Record<string, unknown>) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
const logger = pino({ level: "silent" });
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("irreversible body arrives before provider completion, without reasoning or duplicate validated replay", { timeout: 3000 }, async () => {
  const firstBody = signal();
  let providerCompleted = false;
  const response = new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(event({ reasoning_content: "private" }));
      controller.enqueue(event({ content: "公开正文" }));
      await firstBody.promise;
      providerCompleted = true;
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    }
  }), { headers: { "Content-Type": "text/event-stream" } });
  const live: string[] = [];
  const validated: string[] = [];
  await withMockFetch([{ assertRequest() {}, response }], async () => {
    const result = await new LlmClient(createLlmTestConfig(), logger).generate({
      messages: [{ role: "user", content: "你好" }],
      onIrreversibleTextDelta(delta) {
        assert.equal(providerCompleted, false);
        live.push(delta);
        firstBody.resolve();
      },
      onTextDelta(delta) { validated.push(delta); }
    });
    assert.equal(result.text, "公开正文");
  });
  assert.deepEqual(live, ["公开正文"]);
  assert.deepEqual(validated, ["公开正文"]);
});

test("provider failure after irreversible body never switches to a fallback candidate", { timeout: 3000 }, async () => {
  const firstBody = signal();
  const response = new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(event({ content: "部分正文" }));
      await firstBody.promise;
      controller.error(new Error("provider connection lost"));
    }
  }), { headers: { "Content-Type": "text/event-stream" } });
  let fallbacks = 0;
  await withMockFetch([{ assertRequest() {}, response }], async () => {
    await assert.rejects(new LlmClient(createLlmTestConfig([{}, { model: "fallback" }]), logger).generate({
      messages: [{ role: "user", content: "你好" }],
      onIrreversibleTextDelta() { firstBody.resolve(); },
      onFallbackEvent() { fallbacks++; }
    }));
  });
  assert.equal(fallbacks, 0);
});

test("structured output does not use the irreversible channel", async () => {
  let live = 0;
  await withMockFetch([{
    assertRequest() {}, payloads: [{ choices: [{ delta: { content: '{"ok":true}' } }] }]
  }], async () => {
    const result = await new LlmClient(createLlmTestConfig(), logger).generate({
      messages: [{ role: "user", content: "输出JSON" }],
      responseFormat: { type: "json_object" },
      onIrreversibleTextDelta() { live++; }
    });
    assert.equal(result.text, '{"ok":true}');
  });
  assert.equal(live, 0);
});

test("enabled native search remains buffered while a search-capable disabled model can stream", async () => {
  for (const enabled of [false, true]) {
    const config = createLlmTestConfig({ chat: { searchEnabled: enabled, capabilities: { supportsSearch: true } } });
    config.llm.providers.test!.features.search = { type: "flag", path: "enable_search" };
    let live = 0;
    await withMockFetch([{
      assertRequest() {}, payloads: [{ choices: [{ delta: { content: "正文" } }] }]
    }], async () => {
      await new LlmClient(config, logger).generate({
        messages: [{ role: "user", content: "你好" }],
        onIrreversibleTextDelta() { live++; }
      });
    });
    assert.equal(live, enabled ? 0 : 1);
  }
});
