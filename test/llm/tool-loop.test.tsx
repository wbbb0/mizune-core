import test from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { projectFields, projectToolResult } from "../../src/llm/tools/core/toolResultProjection.ts";
import { createLlmTestConfig, createToolDefinition, withMockFetch } from "../helpers/llm-test-support.tsx";

  test("independent same-round tool calls run concurrently and replay results in tool-call order", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    const events: string[] = [];
    const first = createDeferred<string>();
    const second = createDeferred<string>();

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
          assert.equal(body.messages[0].role, "user");
        },
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "tool-call-first",
                  type: "function",
                  function: {
                    name: "read_a",
                    arguments: "{}"
                  }
                },
                {
                  index: 1,
                  id: "tool-call-second",
                  type: "function",
                  function: {
                    name: "read_b",
                    arguments: "{}"
                  }
                }
              ]
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 4);
          assert.equal(body.messages[1].role, "assistant");
          assert.equal(body.messages[2].role, "tool");
          assert.equal(body.messages[2].tool_call_id, "tool-call-first");
          assert.equal(body.messages[2].content, "first-result");
          assert.equal(body.messages[3].role, "tool");
          assert.equal(body.messages[3].tool_call_id, "tool-call-second");
          assert.equal(body.messages[3].content, "second-result");
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
      const generatePromise = client.generate({
        messages: [{ role: "user", content: "read both" }],
        tools: [createToolDefinition("read_a"), createToolDefinition("read_b")],
        toolConcurrency: {
          maxConcurrency: 2,
          analyze: () => ({ kind: "parallel", reads: ["readonly"], writes: [] })
        },
        toolExecutor: async toolCall => {
          events.push(`start:${toolCall.function.name}`);
          if (toolCall.function.name === "read_a") {
            return first.promise;
          }
          return second.promise;
        }
      });

      await waitFor(() => events.length === 2);
      assert.deepEqual(events, ["start:read_a", "start:read_b"]);

      second.resolve("second-result");
      first.resolve("first-result");

      const result = await generatePromise;
      assert.equal(result.text, "done");
    });
  });

  test("same-round tool calls append supplemental messages after all tool results", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
        },
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "tool-call-first",
                  type: "function",
                  function: {
                    name: "read_a",
                    arguments: "{}"
                  }
                },
                {
                  index: 1,
                  id: "tool-call-second",
                  type: "function",
                  function: {
                    name: "read_b",
                    arguments: "{}"
                  }
                }
              ]
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 5);
          assert.equal(body.messages[1].role, "assistant");
          assert.equal(body.messages[2].role, "tool");
          assert.equal(body.messages[2].tool_call_id, "tool-call-first");
          assert.equal(body.messages[3].role, "tool");
          assert.equal(body.messages[3].tool_call_id, "tool-call-second");
          assert.equal(body.messages[4].role, "system");
          assert.equal(body.messages[4].content, "补充上下文");
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
        messages: [{ role: "user", content: "read both" }],
        tools: [createToolDefinition("read_a"), createToolDefinition("read_b")],
        toolConcurrency: {
          maxConcurrency: 2,
          analyze: () => ({ kind: "parallel", reads: ["readonly"], writes: [] })
        },
        toolExecutor: async toolCall => {
          if (toolCall.function.name === "read_a") {
            return {
              content: "first-result",
              supplementalMessages: [{ role: "system", content: "补充上下文" }]
            };
          }
          return "second-result";
        }
      });

      assert.equal(result.text, "done");
    });
  });

  test("projected tool results send initial content while exposing canonical content to observers", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    const observedCanonical: string[] = [];

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
        },
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tool-call-projected",
                type: "function",
                function: {
                  name: "projected_tool",
                  arguments: "{}"
                }
              }]
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages[2].role, "tool");
          assert.equal(body.messages[2].content, "{\"ok\":true,\"summary\":\"short\"}");
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
        messages: [{ role: "user", content: "run projected tool" }],
        tools: [createToolDefinition("projected_tool")],
        toolExecutor: async () => projectToolResult({
          toolName: "projected_tool",
          canonical: {
            ok: true,
            summary: "short",
            full: "long canonical detail"
          },
          projection: {
            initial: projectFields(["ok", "summary"])
          }
        }),
        onToolResultMessage(_message, _toolCall, metadata) {
          if (metadata?.canonicalContent) {
            observedCanonical.push(metadata.canonicalContent);
          }
        }
      });

      assert.equal(result.text, "done");
      assert.deepEqual(observedCanonical, ["{\"ok\":true,\"summary\":\"short\",\"full\":\"long canonical detail\"}"]);
    });
  });

  test("plain string tool results are treated as identity canonical results", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    const observedCanonical: string[] = [];

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
        },
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tool-call-plain",
                type: "function",
                function: {
                  name: "plain_tool",
                  arguments: "{}"
                }
              }]
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages[2].content, "{\"ok\":true,\"value\":\"plain\"}");
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
      await client.generate({
        messages: [{ role: "user", content: "run plain tool" }],
        tools: [createToolDefinition("plain_tool")],
        toolExecutor: async () => "{\"ok\":true,\"value\":\"plain\"}",
        onToolResultMessage(_message, _toolCall, metadata) {
          if (metadata?.canonicalContent) {
            observedCanonical.push(metadata.canonicalContent);
          }
        }
      });

      assert.deepEqual(observedCanonical, ["{\"ok\":true,\"value\":\"plain\"}"]);
    });
  });

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

  test("terminal responses still emit one result for every call in the batch", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    const executedNames: string[] = [];
    const observedResults: Array<{ id: string; content: string }> = [];

    await withMockFetch([{
      assertRequest() {},
      payloads: [{
        choices: [{
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-terminal",
                type: "function",
                function: { name: "end_turn_without_reply", arguments: "{}" }
              },
              {
                index: 1,
                id: "call-after-terminal",
                type: "function",
                function: { name: "lookup", arguments: "{}" }
              }
            ]
          }
        }]
      }]
    }], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "结束" }],
        tools: [createToolDefinition("end_turn_without_reply"), createToolDefinition("lookup")],
        toolExecutor: async (toolCall) => {
          executedNames.push(toolCall.function.name);
          return {
            content: "{\"ok\":true}",
            ...(toolCall.function.name === "end_turn_without_reply"
              ? { terminalResponse: { text: "" } }
              : {})
          };
        },
        onToolResultMessage(message) {
          observedResults.push({
            id: message.tool_call_id ?? "",
            content: String(message.content)
          });
        }
      });

      assert.equal(result.text, "");
      assert.deepEqual(executedNames, ["end_turn_without_reply"]);
      assert.deepEqual(observedResults.map((item) => item.id), ["call-terminal", "call-after-terminal"]);
      assert.equal(JSON.parse(observedResults[1]!.content).error_code, "skipped_after_terminal_response");
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

  test("provider preflight projection covers steer messages and tool results", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    let consumeCount = 0;

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages[0].content, "看天气");
        },
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tool-call-projection",
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
          assert.equal(body.messages[2].role, "tool");
          assert.equal(body.messages[2].content, "TOOL SAFE");
          assert.equal(body.messages[3].role, "user");
          assert.equal(body.messages[3].content, "STEER SAFE");
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
        messages: [{ role: "user", content: "看天气" }],
        tools: [createToolDefinition("lookup")],
        toolExecutor: async () => "TOOL RAW",
        consumeSteerMessages: () => {
          consumeCount += 1;
          return consumeCount === 2 ? [{ role: "user", content: "STEER RAW" }] : [];
        },
        projectMessagesBeforeProvider: (messages) => messages.map((message) => {
          if (message.content === "TOOL RAW") {
            return { ...message, content: "TOOL SAFE" };
          }
          if (message.content === "STEER RAW") {
            return { ...message, content: "STEER SAFE" };
          }
          return message;
        })
      });

      assert.equal(result.text, "done");
    });
  });

  test("max-iteration stops without a hidden provider call or consuming later steer", async () => {
    const config = createLlmTestConfig();
    config.llm.toolCallMaxIterations = 1;
    const client = new LlmClient(config, pino({ level: "silent" }));
    let consumeCount = 0;

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages[0].content, "看天气");
        },
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tool-call-fallback-projection",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{\"query\":\"weather\"}"
                }
              }]
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "看天气" }],
        tools: [createToolDefinition("lookup")],
        toolExecutor: async () => "TOOL RAW",
        consumeSteerMessages: () => {
          consumeCount += 1;
          return consumeCount > 1 ? [{ role: "user", content: "STEER RAW" }] : [];
        },
        projectMessagesBeforeProvider: (messages) => messages.map((message) => {
          if (message.content === "TOOL RAW") {
            return { ...message, content: "TOOL SAFE" };
          }
          if (message.content === "STEER RAW") {
            return { ...message, content: "STEER SAFE" };
          }
          return message;
        })
      });

      assert.equal(result.text, "");
      assert.deepEqual(result.finishReason, { kind: "tool_call_limit", maxIterations: 1 });
      assert.equal(consumeCount, 1);
      assert.deepEqual(result.providerCallUsages?.map((event) => event.phase), ["tool_call"]);
    });
  });

  test("unadvertised tool calls return failed tool results and continue the model loop", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    let executeCount = 0;
    const usagePhases: string[] = [];

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.ok(!body.tools || body.tools.length === 0);
        },
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tool-call-not-advertised",
                type: "function",
                function: {
                  name: "delete",
                  arguments: "{\"path\":\"unexpected.txt\"}"
                }
              }]
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 3);
          assert.equal(body.messages[1].role, "assistant");
          assert.equal(body.messages[1].tool_calls[0].id, "tool-call-not-advertised");
          assert.equal(body.messages[2].role, "tool");
          assert.equal(body.messages[2].tool_call_id, "tool-call-not-advertised");
          const failure = JSON.parse(body.messages[2].content);
          assert.equal(failure.ok, false);
          assert.equal(failure.error_code, "tool_not_available");
          assert.doesNotMatch(failure.recovery, /request_toolset|list_available_toolsets/);
        },
        payloads: [{
          choices: [{
            delta: {
              content: "当前没有开放删除工具，操作没有执行。"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "只总结，不要调用工具" }],
        tools: [],
        onProviderCallUsage(event) {
          usagePhases.push(event.phase);
        },
        toolExecutor: async () => {
          executeCount += 1;
          return "{}";
        }
      });
      assert.equal(executeCount, 0);
      assert.equal(result.text, "当前没有开放删除工具，操作没有执行。");
      assert.deepEqual(usagePhases, ["tool_call", "final_response"]);
    });
  });

  test("complete DSML tool envelopes are discarded and corrected without leaking text deltas", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    const visibleDeltas: string[] = [];
    const usagePhases: string[] = [];

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
        },
        payloads: [{
          choices: [{
            delta: {
              content: "说明如下：\n```xml\n<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"delete\"></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>\n```"
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 2);
          assert.equal(body.messages[0].role, "system");
          assert.match(body.messages[0].content, /任何工具都没有执行/);
          assert.doesNotMatch(body.messages[0].content, /request_toolset|list_available_toolsets/);
          assert.equal(body.messages.some((message: any) => message.role === "assistant"), false);
        },
        payloads: [{
          choices: [{ delta: { content: "没有执行任何工具。" } }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "继续" }],
        tools: [],
        onTextDelta(delta) {
          visibleDeltas.push(delta);
        },
        onProviderCallUsage(event) {
          usagePhases.push(event.phase);
        }
      });

      assert.equal(result.text, "没有执行任何工具。");
      assert.deepEqual(visibleDeltas, ["没有执行任何工具。"]);
      assert.deepEqual(usagePhases, ["invalid_response", "final_response"]);
    });
  });

  test("protocol recovery attempts are bounded independently from tool iterations", async () => {
    const config = createLlmTestConfig();
    config.llm.toolCallProtocolRecoveryMaxAttempts = 1;
    const client = new LlmClient(config, pino({ level: "silent" }));

    await withMockFetch([{
      assertRequest() {},
      payloads: [{
        choices: [{
          delta: {
            content: "<｜｜DSML｜｜tool_calls></｜｜DSML｜｜tool_calls>"
          }
        }]
      }]
    }], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "继续" }],
        tools: []
      });

      assert.deepEqual(result.finishReason, {
        kind: "tool_call_limit",
        maxIterations: 4,
        cause: "protocol_recovery",
        protocolRecoveries: 1
      });
      assert.deepEqual(result.providerCallUsages?.map((event) => event.phase), ["invalid_response"]);
    });
  });

  test("invalid tool arguments return a correlated failure without executing the tool", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    let executeCount = 0;

    await withMockFetch([
      {
        assertRequest() {},
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-invalid-args",
                type: "function",
                function: { name: "write_file", arguments: "" }
              }]
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages[2].tool_call_id, "call-invalid-args");
          const failure = JSON.parse(body.messages[2].content);
          assert.equal(failure.error_code, "invalid_arguments_json");
        },
        payloads: [{ choices: [{ delta: { content: "参数有误，未写入文件。" } }] }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "写文件" }],
        tools: [{
          type: "function",
          function: {
            name: "write_file",
            description: "写文件",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"]
            }
          }
        }],
        toolExecutor: async () => {
          executeCount += 1;
          return "{}";
        }
      });

      assert.equal(executeCount, 0);
      assert.equal(result.text, "参数有误，未写入文件。");
    });
  });

  test("malformed tool envelopes are rejected atomically before transcript callbacks or execution", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    let executeCount = 0;
    let assistantToolCallCount = 0;
    let toolResultCount = 0;

    await withMockFetch([
      {
        assertRequest() {},
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                type: "function",
                function: { name: "lookup", arguments: "{}" }
              }]
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 2);
          assert.equal(body.messages[0].role, "system");
          assert.equal(body.messages.some((message: any) => message.role === "assistant"), false);
          assert.equal(body.messages.some((message: any) => message.role === "tool"), false);
        },
        payloads: [{ choices: [{ delta: { content: "工具调用结构有误，未执行。" } }] }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "查询" }],
        tools: [createToolDefinition("lookup")],
        toolExecutor: async () => {
          executeCount += 1;
          return "{}";
        },
        onAssistantToolCalls() {
          assistantToolCallCount += 1;
        },
        onToolResultMessage() {
          toolResultCount += 1;
        }
      });

      assert.equal(result.text, "工具调用结构有误，未执行。");
      assert.equal(executeCount, 0);
      assert.equal(assistantToolCallCount, 0);
      assert.equal(toolResultCount, 0);
      assert.deepEqual(result.providerCallUsages?.map((event) => event.phase), ["invalid_response", "final_response"]);
    });
  });

  test("mixed advertised and unadvertised calls preserve result order and execute only allowed tools", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    const executedNames: string[] = [];

    await withMockFetch([
      {
        assertRequest() {},
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-allowed",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" }
                },
                {
                  index: 1,
                  id: "call-blocked",
                  type: "function",
                  function: { name: "delete", arguments: "{}" }
                }
              ]
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages[2].tool_call_id, "call-allowed");
          assert.equal(body.messages[2].content, "lookup-result");
          assert.equal(body.messages[3].tool_call_id, "call-blocked");
          assert.equal(JSON.parse(body.messages[3].content).error_code, "tool_not_available");
        },
        payloads: [{ choices: [{ delta: { content: "查询完成，删除未执行。" } }] }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "查询并删除" }],
        tools: [createToolDefinition("lookup")],
        toolExecutor: async (toolCall) => {
          executedNames.push(toolCall.function.name);
          return "lookup-result";
        }
      });

      assert.deepEqual(executedNames, ["lookup"]);
      assert.equal(result.text, "查询完成，删除未执行。");
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

  test("provider response complete event is emitted before executing tool calls", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    const events: string[] = [];

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
        },
        payloads: [{
          choices: [{
            delta: {
              content: "我先查一下",
              tool_calls: [{
                index: 0,
                id: "tool-call-lookup",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{}"
                }
              }]
            }
          }]
        }]
      },
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 3);
          assert.equal(body.messages[1].role, "assistant");
          assert.equal(body.messages[1].content, "规范化工具前文");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "查完了"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [{ role: "user", content: "查一下" }],
        tools: [createToolDefinition("lookup")],
        onProviderResponseComplete(event) {
          events.push(`provider:${event.phase}:${event.text}`);
        },
        resolveAssistantToolCallContent(event) {
          events.push(`resolve:${event.text}`);
          return "规范化工具前文";
        },
        onAssistantToolCalls(message) {
          events.push(`assistant-tool-calls:${message.content}`);
        },
        toolExecutor: async () => {
          events.push("tool-executor");
          return "{\"ok\":true}";
        }
      });

      assert.equal(result.text, "查完了");
      assert.deepEqual(events, [
        "provider:tool_call:我先查一下",
        "resolve:我先查一下",
        "assistant-tool-calls:规范化工具前文",
        "tool-executor",
        "provider:final_response:查完了"
      ]);
    });
  });

  test("provider requests repair incomplete tool-call history before sending", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 4);
          assert.equal(body.messages[0].role, "user");
          assert.equal(body.messages[1].role, "assistant");
          assert.equal(body.messages[1].content, "我先查一下");
          assert.equal(body.messages[1].tool_calls, undefined);
          assert.equal(body.messages[2].role, "system");
          assert.match(body.messages[2].content, /工具调用历史不完整/);
          assert.equal(body.messages[3].role, "user");
        },
        payloads: [{
          choices: [{
            delta: {
              content: "可以继续"
            }
          }]
        }]
      }
    ], async () => {
      const result = await client.generate({
        messages: [
          { role: "user", content: "查一下" },
          {
            role: "assistant",
            content: "我先查一下",
            tool_calls: [{
              id: "tool-call-missing",
              type: "function",
              function: {
                name: "lookup",
                arguments: "{}"
              }
            }]
          },
          { role: "user", content: "继续" }
        ]
      });

      assert.equal(result.text, "可以继续");
    });
  });

  test("aborted tool loops stop before issuing the next provider request", async () => {
    const client = new LlmClient(createLlmTestConfig(), pino({ level: "silent" }));
    const abortController = new AbortController();

    await withMockFetch([
      {
        assertRequest(body: any) {
          assert.equal(body.messages.length, 1);
        },
        payloads: [{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "tool-call-aborted",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: "{}"
                }
              }]
            }
          }]
        }]
      }
    ], async () => {
      await assert.rejects(
        client.generate({
          messages: [{ role: "user", content: "查一下" }],
          tools: [createToolDefinition("lookup")],
          abortSignal: abortController.signal,
          toolExecutor: async () => {
            abortController.abort();
            return "{\"ok\":true}";
          }
        }),
        /aborted/i
      );
    });
  });

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail("condition was not met");
}
