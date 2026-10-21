import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/logger.ts";
import { FILTERED_LOG_MESSAGE } from "../../src/logging/logContentFilter.ts";
import type { RecentErrorLogInput } from "../../src/runtime/recentErrorStore.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { createLlmTestConfig, createSseResponse } from "../helpers/llm-test-support.tsx";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { setFetchImplementationForTests } from "../../src/services/proxy/index.ts";

const secret = "PRIVATE_CHAT_SENTINEL_聊天正文";

function setup(includeConversationContent = false) {
  const config = createTestAppConfig({ logLevel: "trace", logIncludeConversationContent: includeConversationContent });
  const lines: string[] = [];
  const errors: RecentErrorLogInput[] = [];
  const logger = createLogger(config, {
    destination: { write: (line) => { lines.push(line); } },
    recentErrorSink: (error) => { errors.push(error); }
  });
  return { config, logger, lines, errors, records: () => lines.map(line => JSON.parse(line)) };
}

test("content filter hides all free text and nested payloads while retaining diagnostic metadata", () => {
  const { logger, lines, records } = setup();
  logger.info({
    sessionId: "acc1:p:123", userId: "123", modelRef: "openrouter/test", durationMs: 60,
    streaming: true, text: secret, name: secret, rawMessagePreview: secret,
    argumentsPreview: secret, resultPreview: secret, reason: secret, command: secret,
    url: secret, filePath: secret, segments: [{ type: "text", data: { text: secret } }],
    unknown: { modelRef: secret }, [secret]: 1
  }, "message_received");
  const record = records()[0];
  assert.equal(record.msg, "message_received");
  assert.equal(record.sessionId, "acc1:p:123");
  assert.equal(record.modelRef, "openrouter/test");
  assert.equal(record.durationMs, 60);
  assert.equal(record.streaming, true);
  assert.equal(record.text, undefined);
  assert.equal(record.reason, undefined);
  assert.equal(record.unknown, undefined);
  assert.ok(!lines.join("").includes(secret));
});

test("serialized output filtering covers child bindings, all levels, interpolation and Error causes", () => {
  const { logger, lines, records, errors } = setup();
  const child = logger.child({ text: secret, nested: { body: secret }, sessionId: "acc1:p:123" });
  const error = new Error(`LLM API error: 429 ${secret}`, { cause: new Error(secret) });
  Object.assign(error, { responseBody: secret });
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    child[level]({ error, body: secret }, "generation_failed");
  }
  child.info("message_received %s", secret);
  child.info(secret);
  child.error(error);
  child.error({ err: { message: secret, stack: secret, cause: { message: secret } } }, "generation_failed");
  assert.ok(!lines.join("").includes(secret));
  assert.ok(!JSON.stringify(errors).includes(secret));
  assert.equal(records()[0].error.message, "LLM API error: 429");
  assert.equal(records()[0].error.stack, undefined);
  assert.equal(records()[6].msg, FILTERED_LOG_MESSAGE);
  assert.equal(records()[7].msg, FILTERED_LOG_MESSAGE);
  assert.equal(errors.length, 4);
  assert.equal(errors[0]?.message, "LLM API error: 429");
  assert.equal(errors[0]?.context?.sessionId, "acc1:p:123");
});

test("content filter retains precise known timeouts but rejects arbitrary suffixes and unknown events", () => {
  const { logger, records, lines } = setup();
  logger.error({ error: new Error("LLM first token timeout after 60000ms") }, "llm_candidate_failed");
  logger.error({ error: new Error(`LLM first token timeout after 60000ms ${secret}`) }, secret);
  logger.error({ err: Object.assign(new Error(secret), { code: "ETIMEDOUT", statusCode: 504 }) }, "generation_failed");
  assert.equal(records()[0].error.message, "LLM first token timeout after 60000ms");
  assert.equal(records()[0].msg, "llm_candidate_failed");
  assert.equal(records()[1].error.message, FILTERED_LOG_MESSAGE);
  assert.equal(records()[1].msg, FILTERED_LOG_MESSAGE);
  assert.equal(records()[2].err.code, "ETIMEDOUT");
  assert.equal(records()[2].err.statusCode, 504);
  assert.ok(!lines.join("").includes(secret));
});

test("conversation content defaults off and follows live config changes without mutating caller data", () => {
  assert.equal(createTestAppConfig().logIncludeConversationContent, false);
  const { config, logger, lines, errors } = setup(true);
  const child = logger.child({ body: secret });
  const input = { text: secret, error: new Error(secret) };
  child.error(input, "generation_failed");
  assert.ok(lines[0]?.includes(secret));
  assert.equal(errors[0]?.message, secret);
  config.logIncludeConversationContent = false;
  child.error(input, "generation_failed");
  assert.ok(!lines[1]?.includes(secret));
  assert.equal(errors[1]?.message, FILTERED_LOG_MESSAGE);
  assert.equal(input.text, secret);
  assert.equal(input.error.message, secret);
  config.logIncludeConversationContent = true;
  child.error(input, "generation_failed");
  assert.ok(lines[2]?.includes(secret));
  assert.equal(errors[2]?.message, secret);
});

for (const fails of [false, true]) {
  test(`content filtering preserves ${fails ? "forced failure" : "enabled success"} exchange dumps`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "llm-log-filter-"));
    const config = createLlmTestConfig();
    config.dataDir = dataDir;
    config.logIncludeConversationContent = false;
    config.logLevel = "trace";
    config.llm.debugDump.enabled = !fails;
    const lines: string[] = [];
    const errors: RecentErrorLogInput[] = [];
    const logger = createLogger(config, {
      destination: { write: line => { lines.push(line); } },
      recentErrorSink: error => { errors.push(error); }
    });
    const client = new LlmClient(config, logger);
    setFetchImplementationForTests(async () => fails
      ? new Response(JSON.stringify({ error: secret }), { status: 400, headers: { "Content-Type": "application/json" } })
      : createSseResponse([{ choices: [{ delta: { content: secret }, finish_reason: "stop" }] }]));
    try {
      const request = client.generate({ messages: [{ role: "user", content: secret }] });
      if (fails) await assert.rejects(request, /LLM API error: 400/);
      else assert.equal((await request).text, secret);
      const filename = fails ? "last-failed-exchange.json" : "last-exchange.json";
      const dump = JSON.parse(await readFile(join(dataDir, "dump", filename), "utf8"));
      assert.ok(dump.exchanges[0].requestBody.includes(secret));
      assert.ok(dump.exchanges[0].rawBody.includes(secret));
      assert.ok(!lines.join("").includes(secret));
      assert.ok(!JSON.stringify(errors).includes(secret));
    } finally {
      setFetchImplementationForTests(null);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
