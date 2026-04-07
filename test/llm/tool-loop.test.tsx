import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { createLlmTestConfig, createToolDefinition, runCase, withMockFetch } from "../helpers/llm-test-support.tsx";

async function main() {
  await runCase("terminal tool responses stop the tool loop without a follow-up model call", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
          assert.equal(body.messages[0].role, "user");
        },
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tool-call-end-turn",
                type: "function",
                function: {
                  name: "end_turn_without_reply",
                  arguments: "{\"reason\":\"明确收尾\"}"
                }
              }]
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "好的" }],
        tools: [createToolDefinition("end_turn_without_reply")],
        toolExecutor: async () => ({
          content: "{\"ok\":true,\"ended\":true}",
          terminalResponse: {
            text: ""
          }
        })
      });

      assert.equal(result.text, "");
    });
  });

  await runCase("steer user messages are injected before the next tool-loop model call without opening a new generate", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    let consumeCount = 0;

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
          assert.equal(body.messages[0].role, "user");
        },
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tool-call-steer",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{\"query\":\"weather\"}"
                }
              }]
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 4);
          assert.equal(body.messages[0].role, "user");
          assert.equal(body.messages[1].role, "assistant");
          assert.equal(body.messages[2].role, "tool");
          assert.equal(body.messages[3].role, "user");
          assert.equal(body.messages[3].content, "再顺便看一下风速");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "已经补上风速"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "看天气" }],
        tools: [createToolDefinition("lookup")],
        toolExecutor: async () => "{\"ok\":true}",
        consumeSteerMessages: () => {
          consumeCount += 1;
          if (consumeCount !== 2) {
            return [];
          }
          return [{ role: "user", content: "再顺便看一下风速" }];
        }
      });

      assert.equal(result.text, "已经补上风速");
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
