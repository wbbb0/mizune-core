import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { createLlmTestConfig, createToolDefinition } from "../helpers/llm-test-support.tsx";

  test("api errors force request and error response dumps", async () => {
    const dumpDir = await mkdtemp(join(tmpdir(), "llm-bot-dump-"));
    const config = createLlmTestConfig();
    config.dataDir = join(dumpDir, "acc-test");
    config.llm.debugDump = {
      enabled: false
    };
    const client = new LlmClient(config, pino({ level: "silent" }));
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: "bad tool schema" }),
      {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json" }
      }
    );

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
      globalThis.fetch = originalFetch;
      await rm(dumpDir, { recursive: true, force: true });
    }
  });
