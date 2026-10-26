import pino from "pino";
import { LlmClient } from "../../src/llm/llmClient.ts";
import { createLlmTestConfig, createToolDefinition, withMockFetch } from "../helpers/llm-test-support.tsx";
import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateLlmMessagesTokens,
  estimateLlmToolsTokens,
  projectProviderWorkingMessagesForBudget
} from "../../src/app/generation/providerWorkingMessageBudget.ts";
import type { InternalTranscriptItem } from "../../src/conversation/session/sessionTypes.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

test("provider working messages keep raw tool results below the token trigger", () => {
  const config = createTestAppConfig();
  const messages = [
    { role: "user" as const, content: "hello" },
    { role: "tool" as const, tool_call_id: "tool-1", content: "small result" }
  ];

  const projection = projectProviderWorkingMessagesForBudget({
    messages,
    transcript: [createObservedToolResult("tool-1", "compact result", 0)],
    config,
    triggerTokens: 1000
  });

  assert.equal(projection.compactedToolResults, 0);
  assert.strictEqual(projection.messages, messages);
});

test("provider working messages reuse tool observation replay content only after exceeding the token trigger", () => {
  const config = createTestAppConfig();
  const projection = projectProviderWorkingMessagesForBudget({
    messages: [
      { role: "user" as const, content: "hello" },
      { role: "tool" as const, tool_call_id: "tool-1", content: "x".repeat(1000) }
    ],
    transcript: [createObservedToolResult("tool-1", "{\"compacted\":true}", 0)],
    config,
    triggerTokens: 50
  });

  assert.equal(projection.compactedToolResults, 1);
  assert.equal(projection.messages[1]?.content, "{\"compacted\":true}");
  assert.ok(projection.afterTokens < projection.beforeTokens);
});

test("provider working messages preserve recent raw tool results according to observation policy", () => {
  const config = createTestAppConfig();
  const projection = projectProviderWorkingMessagesForBudget({
    messages: [
      { role: "user" as const, content: "hello" },
      { role: "tool" as const, tool_call_id: "old-tool", content: "x".repeat(1000) },
      { role: "tool" as const, tool_call_id: "new-tool", content: "y".repeat(1000) }
    ],
    transcript: [
      createObservedToolResult("old-tool", "old compact", 1),
      createObservedToolResult("new-tool", "new compact", 1)
    ],
    config,
    triggerTokens: 50
  });

  assert.equal(projection.compactedToolResults, 1);
  assert.equal(projection.messages[1]?.content, "old compact");
  assert.equal(projection.messages[2]?.content, "y".repeat(1000));
});

test("provider working messages keep replay-safe raw content when its replay projection costs more tokens", () => {
  const config = createTestAppConfig();
  const rawContent = "short result";
  const projection = projectProviderWorkingMessagesForBudget({
    messages: [
      { role: "user" as const, content: "x".repeat(1000) },
      { role: "tool" as const, tool_call_id: "tool-1", content: rawContent }
    ],
    transcript: [createObservedToolResult("tool-1", "expanded replay result ".repeat(100), 0)],
    config,
    triggerTokens: 50
  });

  assert.equal(projection.compactedToolResults, 0);
  assert.equal(projection.messages[1]?.content, rawContent);
});

test("provider working messages preserve old tool results with full retention", () => {
  const config = createTestAppConfig();
  const rawContent = "x".repeat(1000);
  const projection = projectProviderWorkingMessagesForBudget({
    messages: [
      { role: "user" as const, content: "hello" },
      { role: "tool" as const, tool_call_id: "tool-1", content: rawContent }
    ],
    transcript: [createObservedToolResult("tool-1", "compact", 0, { retention: "full" })],
    config,
    triggerTokens: 50
  });

  assert.equal(projection.compactedToolResults, 0);
  assert.equal(projection.messages[1]?.content, rawContent);
});

test("provider working messages do not preserve raw tool results marked replay unsafe", () => {
  const config = createTestAppConfig();
  const projection = projectProviderWorkingMessagesForBudget({
    messages: [
      { role: "user" as const, content: "hello" },
      { role: "tool" as const, tool_call_id: "unsafe-tool", content: "x".repeat(1000) }
    ],
    transcript: [createObservedToolResult("unsafe-tool", "unsafe compact", 5, { replaySafe: false })],
    config,
    triggerTokens: 50
  });

  assert.equal(projection.compactedToolResults, 1);
  assert.equal(projection.messages[1]?.content, "unsafe compact");
});

test("provider working messages do not preserve pinned raw tool results marked replay unsafe", () => {
  const config = createTestAppConfig();
  const projection = projectProviderWorkingMessagesForBudget({
    messages: [
      { role: "user" as const, content: "hello" },
      { role: "tool" as const, tool_call_id: "pinned-unsafe-tool", content: "x".repeat(1000) }
    ],
    transcript: [createObservedToolResult("pinned-unsafe-tool", "pinned unsafe compact", 5, {
      replaySafe: false,
      pinned: true
    })],
    config,
    triggerTokens: 50
  });

  assert.equal(projection.compactedToolResults, 1);
  assert.equal(projection.messages[1]?.content, "pinned unsafe compact");
});

test("超限投影保留工具及其成本，由上层决定历史压缩", () => {
  const config = createTestAppConfig();
  const messages = [{ role: "user" as const, content: "x".repeat(1000) }];
  const tools = [createToolDefinition("large_tool")];
  const projection = projectProviderWorkingMessagesForBudget({ messages, tools, transcript: [], config, triggerTokens: 50 });
  assert.deepEqual(projection.messages, messages);
  assert.equal(projection.afterTokens, estimateLlmMessagesTokens(messages, config) + estimateLlmToolsTokens(tools, config) + 4);
  assert.ok(projection.afterTokens > 50);
});

function createObservedToolResult(
  toolCallId: string,
  replayContent: string,
  preserveRecentRawCount: number,
  options?: {
    replaySafe?: boolean;
    pinned?: boolean;
    retention?: "full" | "summary";
  }
): InternalTranscriptItem {
  return {
    kind: "tool_result",
    llmVisible: true,
    timestampMs: 1,
    toolCallId,
    toolName: "filesystem_read",
    content: "raw",
    observation: {
      contentHash: `hash-${toolCallId}`,
      inputTokensEstimate: 100,
      summary: `summary ${toolCallId}`,
      retention: options?.retention ?? "summary",
      replayContent,
      replaySafe: options?.replaySafe ?? true,
      refetchable: true,
      pinned: options?.pinned ?? false,
      preserveRecentRawCount
    }
  };
}

test("image transport size does not exhaust working message budget or disable tools", () => {
  const config = createTestAppConfig();
  const makeMessages = (url: string) => [{
    role: "user" as const,
    content: [{ type: "text" as const, text: "请查看图片。" }, { type: "image_url" as const, image_url: { url } }]
  }];
  const small = makeMessages("https://example.com/image.png");
  const large = makeMessages("data:image/png;base64," + "a".repeat(2_400_000));
  assert.equal(estimateLlmMessagesTokens(small, config), estimateLlmMessagesTokens(large, config));
  assert.ok(estimateLlmMessagesTokens(large, config) > 1000);
  const projection = projectProviderWorkingMessagesForBudget({ messages: large, transcript: [], config, triggerTokens: 8000 });
  assert.strictEqual(projection.messages, large);
  const manyImages = Array.from({ length: 10 }, () => large[0]!);
  assert.ok(projectProviderWorkingMessagesForBudget({ messages: manyImages, transcript: [], config, triggerTokens: 8000 }).afterTokens > 8000);
});

test("audio transport bytes are not estimated as text tokens", () => {
  const config = createTestAppConfig();
  const estimate = (data: string) => estimateLlmMessagesTokens([{
    role: "user",
    content: [{ type: "input_audio", input_audio: { data, format: "wav" } }]
  }], config);
  assert.equal(estimate("abcd"), estimate("a".repeat(2_400_000)));
  assert.ok(estimate("abcd") > 0);
});

test("asset_media_view large image preserves send tool through the next provider call", async () => {
  const config = createLlmTestConfig({
    chat: { capabilities: { supportsVision: true } }
  });
  const definitions = [createToolDefinition("asset_media_view"), createToolDefinition("asset_send_to_chat")];
  const call = (id: string, name: string) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "{}" } }] } }] });
  await withMockFetch([
    { assertRequest() {}, payloads: [call("view-1", "asset_media_view")] },
    {
      assertRequest(body: any) {
        assert.ok(body.tools.some((tool: any) => tool.function.name === "asset_send_to_chat"));
        assert.ok(body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === "image_url")));
        assert.ok(!body.messages.some((message: any) => typeof message.content === "string" && message.content.includes("当前工具链上下文已接近上限")));
      },
      payloads: [call("send-1", "asset_send_to_chat")]
    },
    { assertRequest() {}, payloads: [{ choices: [{ delta: { content: "已发送。" } }] }] }
  ], async () => {
    const result = await new LlmClient(config, pino({ level: "silent" })).generate({
      messages: [{ role: "user", content: "看图后发送图片。" }],
      tools: definitions,
      projectMessagesBeforeProvider(messages) {
        const projection = projectProviderWorkingMessagesForBudget({ messages, tools: definitions, transcript: [], config, triggerTokens: 8000 });
        return projection.messages;
      },
      async toolExecutor(tool) {
        if (tool.function.name !== "asset_media_view") return '{"ok":true}';
        return {
          content: '{"ok":true,"attachedCount":1}',
          supplementalMessages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "a".repeat(2_400_000) } }] }],
          toString() { return '{"ok":true,"attachedCount":1}'; }
        };
      }
    });
    assert.equal(result.text, "已发送。");
  });
});
