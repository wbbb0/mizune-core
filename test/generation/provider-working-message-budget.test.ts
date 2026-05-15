import test from "node:test";
import assert from "node:assert/strict";
import { projectProviderWorkingMessagesForBudget } from "../../src/app/generation/providerWorkingMessageBudget.ts";
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
  assert.equal(projection.toolsDisabled, false);
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

test("provider working messages disable more tools when over budget cannot be compacted", () => {
  const config = createTestAppConfig();
  const projection = projectProviderWorkingMessagesForBudget({
    messages: [
      { role: "user" as const, content: "x".repeat(1000) }
    ],
    transcript: [],
    config,
    triggerTokens: 50
  });

  assert.equal(projection.compactedToolResults, 0);
  assert.equal(projection.toolsDisabled, true);
  assert.equal(projection.messages.at(-1)?.role, "system");
  assert.match(String(projection.messages.at(-1)?.content), /不要继续调用工具/);
});

function createObservedToolResult(
  toolCallId: string,
  replayContent: string,
  preserveRecentRawCount: number,
  options?: {
    replaySafe?: boolean;
    pinned?: boolean;
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
      retention: "summary",
      replayContent,
      replaySafe: options?.replaySafe ?? true,
      refetchable: true,
      pinned: options?.pinned ?? false,
      preserveRecentRawCount
    }
  };
}
