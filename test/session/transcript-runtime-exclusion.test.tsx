import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { getProviderTranscriptProjector } from "../../src/app/generation/providerTranscriptProjector.ts";
import type { InternalTranscriptItem } from "../../src/conversation/session/sessionTypes.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

function createExcludedUserMessage(overrides: Partial<InternalTranscriptItem> = {}): InternalTranscriptItem {
  return {
    id: "item-user-1",
    groupId: "group-1",
    kind: "user_message",
    role: "user",
    llmVisible: true,
    chatType: "private",
    userId: "10001",
    senderName: "Alice",
    text: "这条消息应当只保留给后台查看",
    imageIds: [],
    emojiIds: [],
    attachments: [],
    audioCount: 0,
    forwardIds: [],
    replyMessageId: null,
    mentionUserIds: [],
    mentionedAll: false,
    mentionedSelf: false,
    timestampMs: 1,
    runtimeExcluded: true,
    runtimeExcludedAt: 2,
    runtimeExclusionReason: "manual_single",
    ...overrides
  } as any as InternalTranscriptItem;
}

  test("runtimeExcluded transcript items are excluded from llm-visible history but remain in raw session view", () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const session = sessionManager.ensureSession({ id: "qqbot:p:test", type: "private" });
    const excludedMessage = createExcludedUserMessage();
    session.internalTranscript.push(excludedMessage);

    const llmVisibleHistory = sessionManager.getLlmVisibleHistory("qqbot:p:test");
    const sessionView = sessionManager.getSessionView("qqbot:p:test");

    assert.equal(llmVisibleHistory.length, 0);
    assert.equal(sessionView.internalTranscript.length, 1);
    assert.equal((sessionView.internalTranscript[0] as any)?.runtimeExcluded, true);
    assert.equal((sessionView.internalTranscript[0] as any)?.runtimeExclusionReason, "manual_single");
  });

  test("runtimeExcluded assistant tool chains are excluded from openai-style replay", () => {
    const projection = getProviderTranscriptProjector("openai").project({
      transcript: [
        {
          id: "item-tool-call-1",
          groupId: "group-1",
          kind: "assistant_tool_call",
          llmVisible: true,
          timestampMs: 1,
          content: "",
          toolCalls: [{
            id: "call_openai_1",
            type: "function",
            function: {
              name: "shell_run",
              arguments: "{\"cmd\":\"pwd\"}"
            }
          }],
          runtimeExcluded: true,
          runtimeExcludedAt: 2,
          runtimeExclusionReason: "manual_group"
        } as any,
        {
          id: "item-tool-result-1",
          groupId: "group-1",
          kind: "tool_result",
          llmVisible: true,
          timestampMs: 2,
          toolCallId: "call_openai_1",
          toolName: "shell_run",
          content: "{\"stdout\":\"/repo\"}",
          runtimeExcluded: true,
          runtimeExcludedAt: 2,
          runtimeExclusionReason: "manual_group"
        } as any
      ]
    });

    assert.deepEqual(projection.replayMessages, []);
  });

  test("openai-style replay compacts older tool results while keeping recent raw results", () => {
    const transcript: InternalTranscriptItem[] = [];
    for (let index = 1; index <= 6; index += 1) {
      transcript.push({
        id: `item-tool-call-${index}`,
        groupId: `group-${index}`,
        kind: "assistant_tool_call",
        llmVisible: true,
        timestampMs: index * 2 - 1,
        content: "",
        toolCalls: [{
          id: `call_openai_${index}`,
          type: "function",
          function: {
            name: "shell_run",
            arguments: `{"cmd":"echo ${index}"}`
          }
        }]
      } as any);
      transcript.push({
        id: `item-tool-result-${index}`,
        groupId: `group-${index}`,
        kind: "tool_result",
        llmVisible: true,
        timestampMs: index * 2,
        toolCallId: `call_openai_${index}`,
        toolName: "shell_run",
        content: JSON.stringify({ stdout: `RAW-RESULT-${index}` }),
        observation: {
          contentHash: `hash-${index}`,
          inputTokensEstimate: 100,
          summary: `compact summary ${index}`,
          retention: "summary",
          replayContent: JSON.stringify({ compacted: true, summary: `COMPACT-RESULT-${index}` }),
          replaySafe: true,
          refetchable: true,
          pinned: false
        }
      } as any);
    }

    const projection = getProviderTranscriptProjector("openai").project({ transcript });
    const toolMessages = projection.replayMessages.filter((message) => message.role === "tool");

    assert.equal(toolMessages.length, 6);
    assert.equal(toolMessages[0]?.content, JSON.stringify({ compacted: true, summary: "COMPACT-RESULT-1" }));
    assert.equal(toolMessages[1]?.content, JSON.stringify({ stdout: "RAW-RESULT-2" }));
    assert.equal(toolMessages[5]?.content, JSON.stringify({ stdout: "RAW-RESULT-6" }));
  });

  test("openai-style replay keeps old tool results raw when observation retention is full", () => {
    const transcript: InternalTranscriptItem[] = [];
    for (let index = 1; index <= 6; index += 1) {
      transcript.push({
        kind: "assistant_tool_call",
        llmVisible: true,
        timestampMs: index * 2 - 1,
        content: "",
        toolCalls: [{
          id: `call_full_${index}`,
          type: "function",
          function: {
            name: "local_file_write",
            arguments: `{"path":"tmp-${index}.txt"}`
          }
        }]
      } as any);
      transcript.push({
        kind: "tool_result",
        llmVisible: true,
        timestampMs: index * 2,
        toolCallId: `call_full_${index}`,
        toolName: "local_file_write",
        content: JSON.stringify({ ok: true, path: `tmp-${index}.txt` }),
        observation: {
          contentHash: `hash-full-${index}`,
          inputTokensEstimate: 10,
          summary: `write ${index}`,
          retention: index === 1 ? "full" : "summary",
          replayContent: JSON.stringify({ compacted: true, summary: `COMPACT-FULL-${index}` }),
          replaySafe: true,
          refetchable: false,
          pinned: false
        }
      } as any);
    }

    const projection = getProviderTranscriptProjector("openai").project({ transcript });
    const toolMessages = projection.replayMessages.filter((message) => message.role === "tool");

    assert.equal(toolMessages[0]?.content, JSON.stringify({ ok: true, path: "tmp-1.txt" }));
  });
