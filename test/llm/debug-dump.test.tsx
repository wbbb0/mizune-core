import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { setFetchImplementationForTests } from "../../src/services/proxy/index.ts";
import { createLlmTestConfig, createSseResponse, createToolDefinition } from "../helpers/llm-test-support.tsx";

  test("api errors force request and error response dumps", async () => {
    const dumpDir = await mkdtemp(join(tmpdir(), "llm-bot-dump-"));
    const config = createLlmTestConfig();
    config.dataDir = join(dumpDir, "acc-test");
    config.llm.debugDump = {
      enabled: false
    };
    const client = new LlmClient(config, pino({ level: "silent" }));

    setFetchImplementationForTests(async () => new Response(
      JSON.stringify({ error: "bad tool schema" }),
      {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json" }
      }
    ));

    try {
      await assert.rejects(
        client.generate({
          messages: [{ role: "user", content: "ping" }],
          tools: [createToolDefinition("lookup")]
        }),
        /LLM API error: 400 Bad Request/
      );

      const requestDump = JSON.parse(await readFile(join(config.dataDir, "dump", "last-request.json"), "utf8"));
      const responseDump = JSON.parse(await readFile(join(config.dataDir, "dump", "last-response.json"), "utf8"));

      assert.equal(requestDump.endpoint, "https://example.com/v1/chat/completions");
      assert.equal(requestDump.requestBody.model, "fake-model");
      assert.equal(requestDump.requestBody.stream, true);
      assert.equal(Array.isArray(requestDump.requestBody.tools), true);
      assert.equal(requestDump.messages[0].role, "user");

      assert.equal(responseDump.status, 400);
      assert.equal(responseDump.statusText, "Bad Request");
      assert.equal(responseDump.endpoint, "https://example.com/v1/chat/completions");
      assert.match(responseDump.errorBody, /bad tool schema/);
    } finally {
      setFetchImplementationForTests(null);
      await rm(dumpDir, { recursive: true, force: true });
    }
  });

  test("dashscope empty responses write request and response dumps before throwing", async () => {
    const dumpDir = await mkdtemp(join(tmpdir(), "llm-bot-dashscope-dump-"));
    const config = createLlmTestConfig();
    config.dataDir = join(dumpDir, "acc-test");
    config.llm.debugDump = {
      enabled: true
    };
    config.llm.providers.test!.type = "dashscope";
    delete config.llm.providers.test!.baseUrl;
    const client = new LlmClient(config, pino({ level: "silent" }));

    setFetchImplementationForTests(async () => createSseResponse([
      {
        output: {
          choices: [{
            message: {
              role: "assistant",
              content: ""
            }
          }]
        },
        usage: {
          input_tokens: 7,
          output_tokens: 0,
          total_tokens: 7
        }
      }
    ]));

    try {
      await assert.rejects(
        client.generate({
          messages: [{ role: "user", content: "ping" }]
        }),
        /LLM returned empty content/
      );

      const requestDump = JSON.parse(await readFile(join(config.dataDir, "dump", "last-request.json"), "utf8"));
      const responseDump = JSON.parse(await readFile(join(config.dataDir, "dump", "last-response.json"), "utf8"));

      assert.equal(requestDump.endpoint, "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation");
      assert.equal(requestDump.requestBody.model, "fake-model");
      assert.equal(requestDump.requestBody.parameters.incremental_output, true);
      assert.equal(requestDump.messages[0].role, "user");

      assert.equal(responseDump.model, "fake-model");
      assert.equal(responseDump.enableThinking, false);
      assert.equal(responseDump.finalText, "");
      assert.equal(responseDump.chunks[0].usage.input_tokens, 7);
      assert.deepEqual(responseDump.toolCalls, []);
    } finally {
      setFetchImplementationForTests(null);
      await rm(dumpDir, { recursive: true, force: true });
    }
  });

  test("google streamed provider errors write request and response dumps", async () => {
    const dumpDir = await mkdtemp(join(tmpdir(), "llm-bot-google-dump-"));
    const config = createLlmTestConfig();
    config.dataDir = join(dumpDir, "acc-test");
    config.llm.debugDump = {
      enabled: true
    };
    config.llm.providers.test!.type = "google";
    const client = new LlmClient(config, pino({ level: "silent" }));

    setFetchImplementationForTests(async () => createSseResponse([
      {
        error: {
          message: "Resource has been exhausted",
          type: "new_api_error",
          code: "invalid_request"
        }
      }
    ]));

    try {
      await assert.rejects(
        client.generate({
          messages: [{ role: "user", content: "ping" }]
        }),
        /Google AI Studio API stream error: Resource has been exhausted/
      );

      const requestDump = JSON.parse(await readFile(join(config.dataDir, "dump", "last-request.json"), "utf8"));
      const responseDump = JSON.parse(await readFile(join(config.dataDir, "dump", "last-response.json"), "utf8"));

      assert.equal(requestDump.endpoint, "https://example.com/v1/models/fake-model:streamGenerateContent?alt=sse");
      assert.equal(requestDump.requestBody.contents[0].role, "user");
      assert.equal(requestDump.requestBody.contents[0].parts[0].text, "ping");
      assert.equal(requestDump.messages[0].role, "user");

      assert.equal(responseDump.model, "fake-model");
      assert.equal(responseDump.finalText, "");
      assert.equal(responseDump.error.message, "Resource has been exhausted");
      assert.equal(responseDump.chunks[0].error.code, "invalid_request");
    } finally {
      setFetchImplementationForTests(null);
      await rm(dumpDir, { recursive: true, force: true });
    }
  });

for (const scenario of [
  { name: "HTTP error", body: '{"error":"quota exceeded"}', status: 429, contentType: "application/json" },
  { name: "JSON error in HTTP 200", body: '{"error":{"message":"quota exceeded"}}', status: 200, contentType: "application/json" },
  { name: "SSE error", body: 'data: {"error":{"message":"upstream failed"}}\n\n', status: 200, contentType: "text/event-stream" },
  { name: "malformed SSE JSON", body: 'data: {broken json}\n\n', status: 200, contentType: "text/event-stream" },
  { name: "unterminated SSE error", body: 'data: {"error":{"message":"tail error"}}', status: 200, contentType: "text/event-stream" }
]) {
  test(`exchange dump retains raw ${scenario.name} even with debug disabled`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "llm-exchange-"));
    const config = createLlmTestConfig();
    config.dataDir = directory;
    config.llm.debugDump.enabled = false;
    const client = new LlmClient(config, pino({ level: "silent" }));
    setFetchImplementationForTests(async () => new Response(scenario.body, {
      status: scenario.status,
      headers: { "content-type": scenario.contentType, "x-request-id": "test-request", "set-cookie": "secret-cookie" }
    }));
    try {
      await assert.rejects(client.generate({ messages: [{ role: "user", content: "ping" }] }));
      const failed = await readFile(join(directory, "dump/last-failed-exchange.json"), "utf8");
      const dump = JSON.parse(failed);
      assert.equal(dump.outcome, "error");
      assert.ok(dump.error.message);
      assert.equal(dump.exchanges[0].rawBody, scenario.body);
      assert.equal(dump.exchanges[0].status, scenario.status);
      assert.equal(dump.exchanges[0].headers["x-request-id"], "test-request");
      assert.equal(dump.exchanges[0].bodyTruncated, false);
      assert.equal(failed.includes("secret-cookie"), false);
      assert.equal(JSON.parse(dump.exchanges[0].requestBody).model, "fake-model");
      config.llm.debugDump.enabled = true;
      setFetchImplementationForTests(async () => createSseResponse([{ choices: [{ delta: { content: "ok" } }] }]));
      await client.generate({ messages: [{ role: "user", content: "ping" }] });
      assert.equal(await readFile(join(directory, "dump/last-failed-exchange.json"), "utf8"), failed);
      assert.equal(JSON.parse(await readFile(join(directory, "dump/last-exchange.json"), "utf8")).outcome, "success");
    } finally {
      setFetchImplementationForTests(null);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("exchange dump retains partial body and stream transport error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "llm-exchange-stream-"));
  const config = createLlmTestConfig();
  config.dataDir = directory;
  config.llm.debugDump.enabled = false;
  const client = new LlmClient(config, pino({ level: "silent" }));
  const partial = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
  let sent = false;
  setFetchImplementationForTests(async () => new Response(new ReadableStream({
    pull(controller) {
      if (sent) controller.error(new Error("stream disconnected"));
      else { sent = true; controller.enqueue(new TextEncoder().encode(partial)); }
    }
  })));
  try {
    await assert.rejects(client.generate({ messages: [{ role: "user", content: "ping" }] }), /stream disconnected/);
    const dump = JSON.parse(await readFile(join(directory, "dump/last-failed-exchange.json"), "utf8"));
    assert.equal(dump.exchanges[0].rawBody, partial);
    assert.equal(dump.exchanges[0].bodyComplete, false);
    assert.equal(dump.exchanges[0].transportError.message, "stream disconnected");
  } finally {
    setFetchImplementationForTests(null);
    await rm(directory, { recursive: true, force: true });
  }
});

for (const networkFailure of [false, true]) {
  test(`exchange dump bounds response capture and records missing HTTP response (${networkFailure})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "llm-exchange-bounds-"));
    const config = createLlmTestConfig();
    config.dataDir = directory;
    config.llm.debugDump.enabled = false;
    const client = new LlmClient(config, pino({ level: "silent" }));
    const body = "x".repeat(1024 * 1024 + 128);
    setFetchImplementationForTests(async () => {
      if (networkFailure) throw new Error("connection refused");
      return new Response(body);
    });
    try {
      await assert.rejects(client.generate({ messages: [{ role: "user", content: "ping" }] }));
      const dump = JSON.parse(await readFile(join(directory, "dump/last-failed-exchange.json"), "utf8"));
      const exchange = dump.exchanges[0];
      assert.equal(exchange.rawBody.length, networkFailure ? 0 : 1024 * 1024);
      assert.equal(exchange.receivedBytes, networkFailure ? 0 : body.length);
      assert.equal(exchange.bodyTruncated, !networkFailure);
      assert.equal(exchange.bodyComplete, !networkFailure);
      if (networkFailure) {
        assert.equal(exchange.status, undefined);
        assert.equal(exchange.transportError.message, "connection refused");
      }
    } finally {
      setFetchImplementationForTests(null);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("skipDebugDump suppresses raw exchange files for internal calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "llm-exchange-skip-"));
  const config = createLlmTestConfig();
  config.dataDir = directory;
  config.llm.debugDump.enabled = true;
  const client = new LlmClient(config, pino({ level: "silent" }));
  setFetchImplementationForTests(async () => createSseResponse([]));
  try {
    await assert.rejects(client.generate({ messages: [{ role: "user", content: "ping" }], skipDebugDump: true }));
    await assert.rejects(readFile(join(directory, "dump/last-exchange.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(directory, "dump/last-failed-exchange.json")), { code: "ENOENT" });
  } finally {
    setFetchImplementationForTests(null);
    await rm(directory, { recursive: true, force: true });
  }
});
