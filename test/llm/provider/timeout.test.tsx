import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { createProviderTimeoutController } from "../../../src/llm/provider/providerTimeout.ts";
import { LlmClient } from "../../../src/llm/llmClient.ts";
import { createTestAppConfig } from "../../helpers/config-fixtures.tsx";
import { withMockFetch } from "../../helpers/llm-test-support.tsx";

function createDelayedSseResponse(events: Array<{ payload: unknown; delayMs: number }>) {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        let closed = false;

        const close = () => {
          if (closed) {
            return;
          }
          closed = true;
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };

        for (const event of events) {
          setTimeout(() => {
            if (closed) {
              return;
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event.payload)}\n\n`));
          }, event.delayMs);
        }

        const finalDelay = Math.max(...events.map((event) => event.delayMs), 0) + 5;
        setTimeout(close, finalDelay);
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

  test("first token timeout treats reasoning_content as a valid first response", async () => {
    const config = createTestAppConfig({
      llm: {
        enabled: true,
        firstTokenTimeoutMs: 50,
        timeoutMs: 500,
        mainRouting: {
          enableThinking: true
        }
      }
    });
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.model, "fake");
          assert.equal(body.messages[0].role, "user");
        },
        response: createDelayedSseResponse([
          {
            payload: {
              choices: [{
                delta: {
                  reasoning_content: "先想一下"
                }
              }]
            },
            delayMs: 0
          },
          {
            payload: {
              choices: [{
                delta: {
                  content: "最终回复"
                }
              }]
            },
            delayMs: 120
          }
        ])
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "测试超时" }]
      });

      assert.equal(result.text, "最终回复");
    });
  });

  test("createProviderTimeoutController - thinking timeout aborts after configured delay", async () => {
    const controller = createProviderTimeoutController({
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 500,
      thinkingTimeoutMs: 10
    });

    controller.markReasoningStarted();

    await new Promise((resolve) => {
      controller.controller.signal.addEventListener("abort", () => resolve(undefined));
    });

    assert.equal(controller.controller.signal.aborted, true);
    assert.ok(String(controller.controller.signal.reason).includes("thinking timeout after 10ms"));
    controller.cleanup();
  });

  test("createProviderTimeoutController - markFirstTextReceived cancels thinking timer", async () => {
    const controller = createProviderTimeoutController({
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 500,
      thinkingTimeoutMs: 10
    });

    controller.markReasoningStarted();
    controller.markFirstTextReceived();

    let aborted = false;
    controller.controller.signal.addEventListener("abort", () => {
      aborted = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(aborted, false);
    assert.equal(controller.controller.signal.aborted, false);
    controller.cleanup();
  });

  test("createProviderTimeoutController - markReasoningStarted does nothing if thinkingTimeoutMs is undefined", async () => {
    const controller = createProviderTimeoutController({
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 500
    });

    controller.markReasoningStarted();

    let aborted = false;
    controller.controller.signal.addEventListener("abort", () => {
      aborted = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(aborted, false);
    assert.equal(controller.controller.signal.aborted, false);
    controller.cleanup();
  });

  test("createProviderTimeoutController - markReasoningStarted does nothing if thinkingTimeoutMs is zero", async () => {
    const controller = createProviderTimeoutController({
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 500,
      thinkingTimeoutMs: 0
    });

    controller.markReasoningStarted();

    let aborted = false;
    controller.controller.signal.addEventListener("abort", () => {
      aborted = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(aborted, false);
    assert.equal(controller.controller.signal.aborted, false);
    controller.cleanup();
  });

  test("createProviderTimeoutController - markReasoningStarted does nothing if text already received", async () => {
    const controller = createProviderTimeoutController({
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 500,
      thinkingTimeoutMs: 10
    });

    controller.markFirstTextReceived();
    controller.markReasoningStarted();

    let aborted = false;
    controller.controller.signal.addEventListener("abort", () => {
      aborted = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(aborted, false);
    assert.equal(controller.controller.signal.aborted, false);
    controller.cleanup();
  });

  test("createProviderTimeoutController - repeated markReasoningStarted is idempotent", async () => {
    const controller = createProviderTimeoutController({
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 500,
      thinkingTimeoutMs: 10
    });

    controller.markReasoningStarted();
    controller.markReasoningStarted();
    controller.markReasoningStarted();

    await new Promise((resolve) => {
      controller.controller.signal.addEventListener("abort", () => resolve(undefined));
    });

    assert.equal(controller.controller.signal.aborted, true);
    controller.cleanup();
  });

  test("createProviderTimeoutController - cleanup cancels thinking timer", async () => {
    const controller = createProviderTimeoutController({
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 500,
      thinkingTimeoutMs: 10
    });

    controller.markReasoningStarted();
    controller.cleanup();

    let aborted = false;
    controller.controller.signal.addEventListener("abort", () => {
      aborted = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(aborted, false);
    assert.equal(controller.controller.signal.aborted, false);
  });
