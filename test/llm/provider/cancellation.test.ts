import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import pino from "pino";
import { createProviderTimeoutController } from "#llm/provider/providerTimeout.ts";
import { OpenAiCompatibleProvider } from "#llm/provider/providers/openAiCompatibleProvider.ts";
import { runProviderSseStream } from "#llm/provider/providerStreamRunner.ts";
import type { LlmProviderRequestContext } from "#llm/provider/providerTypes.ts";
import { setFetchImplementationForTests } from "#services/proxy/index.ts";
import { createLlmTestConfig } from "../../helpers/llm-test-support.tsx";

test("provider timeout immediately inherits an already aborted signal and its reason", () => {
  const reason = new Error("turn was cancelled before dispatch");
  const parent = AbortSignal.abort(reason);
  const timeout = createProviderTimeoutController({ totalTimeoutMs: 100, firstTokenTimeoutMs: 50, abortSignal: parent });
  assert.equal(timeout.controller.signal.aborted, true);
  assert.equal(timeout.controller.signal.reason, reason);
  assert.equal(getEventListeners(parent, "abort").length, 0);
  timeout.cleanup();
});

test("provider cancellation and cleanup release parent listeners and cannot restart timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = new AbortController();
  const first = createProviderTimeoutController({ totalTimeoutMs: 100, firstTokenTimeoutMs: 50, thinkingTimeoutMs: 10, abortSignal: parent.signal });
  const second = createProviderTimeoutController({ totalTimeoutMs: 100, firstTokenTimeoutMs: 50, thinkingTimeoutMs: 10, abortSignal: parent.signal });
  assert.equal(getEventListeners(parent.signal, "abort").length, 2);
  first.cleanup();
  first.cleanup();
  first.markReasoningStarted();
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  const reason = new Error("caller cancellation");
  parent.abort(reason);
  assert.equal(second.controller.signal.reason, reason);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  t.mock.timers.tick(200);
  assert.equal(first.controller.signal.aborted, false);
  assert.equal(second.controller.signal.reason, reason);
});

test("provider timeout releases its parent without waiting for transport cleanup", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = new AbortController();
  const timeout = createProviderTimeoutController({ totalTimeoutMs: 100, firstTokenTimeoutMs: 10, abortSignal: parent.signal });
  t.mock.timers.tick(10);
  assert.match(String(timeout.controller.signal.reason), /first token timeout/);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  const reason = timeout.controller.signal.reason;
  parent.abort(new Error("later cancellation"));
  t.mock.timers.tick(100);
  assert.equal(timeout.controller.signal.reason, reason);
});

for (const transport of ["chat-completions", "shared-sse"] as const) {
  for (const timing of ["before request", "in flight"] as const) {
    test(`${transport} preserves cancellation ${timing} and releases request listeners`, async () => {
      const config = createLlmTestConfig();
      const context: LlmProviderRequestContext = {
        config, logger: pino({ level: "silent" }), modelRef: "main", model: "fake-model", modelProfile: config.llm.models.main!,
        providerName: "test", providerConfig: config.llm.providers.test!, baseUrl: "https://provider.invalid/v1", candidateIndex: 0
      };
      const parent = new AbortController();
      const reason = new Error("cancel active turn");
      if (timing === "before request") parent.abort(reason);
      setFetchImplementationForTests(async (_url, init) => {
        const signal = init?.signal;
        assert.ok(signal);
        if (timing === "before request") {
          assert.equal(signal.aborted, true);
          throw new DOMException("transport abort", "AbortError");
        }
        return await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("transport abort", "AbortError")), { once: true });
          parent.abort(reason);
        });
      });
      try {
        const params = { messages: [{ role: "user" as const, content: "hello" }], abortSignal: parent.signal };
        const operation = transport === "chat-completions"
          ? new OpenAiCompatibleProvider().generate(context, params)
          : runProviderSseStream({ context, params, endpoint: context.baseUrl, requestBody: {}, resolvedTimeoutMs: 1000, parseData: () => [] });
        await assert.rejects(operation, error => error === reason);
        assert.equal(getEventListeners(parent.signal, "abort").length, 0);
      } finally {
        setFetchImplementationForTests(null);
      }
    });
  }
}
