import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../src/llm/llmClient.ts";
import {
  createLlmTestConfig,
  createToolCallPayload,
  createToolDefinition,
  runCase,
  withMockFetch
} from "../helpers/llm-test-support.tsx";

async function main() {
  await runCase("same-round reasoning_content is relayed back to the follow-up tool request by default", async () => {
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

  await runCase("same-round reasoning relay can be disabled per model", async () => {
    const client = new LlmClient(createLlmTestConfig({
      returnReasoningContentForSameRoundMessages: false
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
          assert.equal("reasoning_content" in body.messages[1], false);
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

  await runCase("reasoning_content is not carried into a new generate call", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
          assert.equal("reasoning_content" in body.messages[0], false);
        },
        payloads: createToolCallPayload("round-1-reasoning")
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages[1].reasoning_content, "round-1-reasoning");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "first round done"
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
          assert.equal(body.messages[0].role, "user");
          assert.equal("reasoning_content" in body.messages[0], false);
        },
        payloads: [{
          choices: [{
            delta: {
              content: "second round done"
            }
          }]
        }]
      }
    ], async () => {
      const first = await client.generate({
        messages: [{ role: "user", content: "first task" }],
        tools: [createToolDefinition("lookup")],
        toolExecutor: async () => "{\"ok\":true}"
      });
      const second = await client.generate({
        messages: [{ role: "user", content: "second task" }]
      });

      assert.equal(first.text, "first round done");
      assert.equal(second.text, "second round done");
    });
  });

  await runCase("same-round reasoning_content is preserved when a steer user message is inserted before the follow-up tool request", async () => {
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

  await runCase("incoming assistant reasoning_content is stripped when all-message relay is disabled", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));

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

  await runCase("incoming assistant reasoning_content is preserved when all-message relay is enabled", async () => {
    const client = new LlmClient(createLlmTestConfig({
      returnReasoningContentForAllMessages: true,
      returnReasoningContentForSameRoundMessages: false
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
