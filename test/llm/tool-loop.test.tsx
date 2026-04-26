import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { createLlmTestConfig, createToolDefinition, withMockFetch } from "../helpers/llm-test-support.tsx";

  test("terminal tool responses stop the tool loop without a follow-up model call", async () => {
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

  test("steer user messages are injected before the next tool-loop model call without opening a new generate", async () => {
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

  test("tool-loop exposes per provider call usage for attribution", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    const callUsages: Array<{ phase: string; outputTokens: number | null; reasoningTokens: number | null }> = [];

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
        },
        payloads: [
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "tool-call-usage",
                  type: "function",
                  function: {
                    name: "lookup",
                    arguments: "{\"query\":\"weather\"}"
                  }
                }]
              }
            }]
          },
          {
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
              completion_tokens_details: {
                reasoning_tokens: 2
              }
            }
          }
        ]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 3);
        },
        payloads: [
          {
            choices: [{
              delta: {
                content: "天气晴"
              }
            }]
          },
          {
            usage: {
              prompt_tokens: 30,
              completion_tokens: 7,
              total_tokens: 37,
              completion_tokens_details: {
                reasoning_tokens: 3
              }
            }
          }
        ]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "看天气" }],
        tools: [createToolDefinition("lookup")],
        toolExecutor: async () => "{\"ok\":true}",
        onProviderCallUsage: (event) => {
          callUsages.push({
            phase: event.phase,
            outputTokens: event.usage.outputTokens,
            reasoningTokens: event.usage.reasoningTokens
          });
        }
      });

      assert.equal(result.text, "天气晴");
      assert.deepEqual(callUsages, [
        { phase: "tool_call", outputTokens: 5, reasoningTokens: 2 },
        { phase: "final_response", outputTokens: 7, reasoningTokens: 3 }
      ]);
      assert.deepEqual(result.providerCallUsages?.map((event) => event.phase), ["tool_call", "final_response"]);
    });
  });
