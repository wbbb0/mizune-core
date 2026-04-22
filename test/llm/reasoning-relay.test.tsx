import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { createLlmTestConfig, createToolCallPayload, createToolDefinition, withMockFetch } from "../helpers/llm-test-support.tsx";

  test("same-round reasoning_content is relayed back to the follow-up tool request by default", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
          assert.equal(body.messages[0].role, "user");
          assert.equal("reasoning_content" in body.messages[0], false);
        },
        payloads: createToolCallPayload("same-round-reasoning")
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 3);
          assert.equal(body.messages[1].role, "assistant");
          assert.equal(body.messages[1].reasoning_content, "same-round-reasoning");
          assert.deepEqual(body.messages[1].tool_calls, [{
            id: "tool-call-1",
            type: "function",
            function: {
              name: "lookup",
              arguments: "{\"query\":\"weather\"}"
            }
          }]);
          assert.equal(body.messages[2].role, "tool");
          assert.equal(body.messages[2].tool_call_id, "tool-call-1");
          assert.equal(body.messages[2].content, "{\"ok\":true}");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "tool completed"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "check the weather" }],
        tools: [createToolDefinition("lookup")],
        toolExecutor: async () => "{\"ok\":true}"
      });

      assert.equal(result.text, "tool completed");
    });
  });

  test("same-round reasoning relay remains enabled even when preserveThinking is disabled", async () => {
    const client = new LlmClient(createLlmTestConfig({
      preserveThinking: false
    }), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
          assert.equal("reasoning_content" in body.messages[0], false);
        },
        payloads: createToolCallPayload("disabled-same-round-reasoning")
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages[1].role, "assistant");
          assert.equal(body.messages[1].reasoning_content, "disabled-same-round-reasoning");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "done"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "do the thing" }],
        tools: [createToolDefinition("lookup")],
        toolExecutor: async () => "{\"ok\":true}"
      });

      assert.equal(result.text, "done");
    });
  });

  test("same-round reasoning_content is preserved when a steer user message is inserted before the follow-up tool request", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    let consumeCount = 0;

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
          assert.equal(body.messages[0].role, "user");
        },
        payloads: createToolCallPayload("steered-round-reasoning")
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 4);
          assert.equal(body.messages[1].role, "assistant");
          assert.equal(body.messages[1].reasoning_content, "steered-round-reasoning");
          assert.equal(body.messages[2].role, "tool");
          assert.equal(body.messages[3].role, "user");
          assert.equal(body.messages[3].content, "补充一个约束");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "收到补充约束"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "先做第一步" }],
        tools: [createToolDefinition("lookup")],
        toolExecutor: async () => "{\"ok\":true}",
        consumeSteerMessages: () => {
          consumeCount += 1;
          if (consumeCount !== 2) {
            return [];
          }
          return [{ role: "user", content: "补充一个约束" }];
        }
      });

      assert.equal(result.text, "收到补充约束");
    });
  });

  test("incoming assistant reasoning_content is stripped when preserveThinking is disabled", async () => {
    const client = new LlmClient(createLlmTestConfig({
      preserveThinking: false
    }), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages[0].role, "assistant");
          assert.equal("reasoning_content" in body.messages[0], false);
        },
        payloads: [{
          choices: [{
            delta: {
              content: "ack"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [
          {
            role: "assistant",
            content: "previous answer",
            reasoning_content: "previous reasoning"
          },
          {
            role: "user",
            content: "continue"
          }
        ]
      });

      assert.equal(result.text, "ack");
    });
  });

  test("incoming assistant reasoning_content is preserved when preserveThinking is enabled", async () => {
    const client = new LlmClient(createLlmTestConfig({
      preserveThinking: true
    }), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages[0].role, "assistant");
          assert.equal(body.messages[0].reasoning_content, "previous reasoning");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "ack"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [
          {
            role: "assistant",
            content: "previous answer",
            reasoning_content: "previous reasoning"
          },
          {
            role: "user",
            content: "continue"
          }
        ]
      });

      assert.equal(result.text, "ack");
    });
  });
