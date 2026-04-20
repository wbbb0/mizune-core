import assert from "node:assert/strict";
import { SessionManager } from "../../src/conversation/session/sessionManager.ts";
import { getProviderTranscriptProjector } from "../../src/app/generation/providerTranscriptProjector.ts";
import type { InternalTranscriptItem } from "../../src/conversation/session/sessionTypes.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";

async function runCase(name: string, fn: () => Promise<void> | void) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

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

async function main() {
  await runCase("runtimeExcluded transcript items are excluded from llm-visible history but remain in raw session view", () => {
    const sessionManager = new SessionManager(createTestAppConfig());
    const session = sessionManager.ensureSession({ id: "private:test", type: "private" });
    const excludedMessage = createExcludedUserMessage();
    session.internalTranscript.push(excludedMessage);

    const llmVisibleHistory = sessionManager.getLlmVisibleHistory("private:test");
    const sessionView = sessionManager.getSessionView("private:test");

    assert.equal(llmVisibleHistory.length, 0);
    assert.equal(sessionView.internalTranscript.length, 1);
    assert.equal((sessionView.internalTranscript[0] as any)?.runtimeExcluded, true);
    assert.equal((sessionView.internalTranscript[0] as any)?.runtimeExclusionReason, "manual_single");
  });

  await runCase("runtimeExcluded assistant tool chains are excluded from openai-style replay", () => {
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
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
