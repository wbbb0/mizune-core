import test from "node:test";
import assert from "node:assert/strict";
import { buildToolObservation } from "../../src/conversation/session/toolObservation.ts";
import { internalTranscriptItemSchema } from "../../src/conversation/session/transcriptContract.ts";
import { projectCompressionHistorySnapshot } from "../../src/conversation/session/sessionTranscript.ts";
import { buildHistorySummaryPrompt } from "../../src/llm/prompts/history-summary.prompt.ts";
import {
  audioTranscriptionToDerivedObservation,
  imageCaptionToDerivedObservation,
  toolObservationToDerivedObservation
} from "../../src/llm/derivations/derivedObservation.ts";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import type { InternalTranscriptItem } from "../../src/conversation/session/sessionTypes.ts";

test("local_file_read observation keeps raw content out of replay and preserves a refetch handle", () => {
  const rawFileContent = Array.from({ length: 180 }, (_, index) => `RAW-LINE-${index + 1} const value${index} = ${index};`).join("\n");
  const rawToolContent = JSON.stringify({
    path: "src/app/generation/providerTranscriptProjector.ts",
    content: rawFileContent,
    startLine: 1,
    endLine: 180,
    totalLines: 500,
    truncated: true
  });

  const observation = buildToolObservation({
    toolName: "local_file_read",
    toolCallId: "call_read_1",
    content: rawToolContent
  });

  assert.equal(observation.retention, "summary");
  assert.equal(observation.refetchable, true);
  assert.equal(observation.replaySafe, true);
  assert.equal(observation.resource?.kind, "local_file");
  assert.equal(observation.resource?.id, "src/app/generation/providerTranscriptProjector.ts");
  assert.equal(observation.resource?.locator, "L1-L180");
  assert.ok(observation.contentHash.length >= 12);
  assert.ok(observation.summary.includes("src/app/generation/providerTranscriptProjector.ts"));
  assert.ok(observation.replayContent.length < rawToolContent.length / 2);
  assert.doesNotMatch(observation.replayContent, /RAW-LINE-120/);
  assert.match(observation.replayContent, /"compacted":true/);
  assert.match(observation.replayContent, /local_file_read/);
  assert.match(observation.replayContent, /start_line=1 end_line=180/);
});

test("current group context observations compact results and preserve refetch hints", () => {
  const tools = [
    {
      name: "view_current_group_info",
      content: {
        ok: true,
        groupId: "123456",
        groupName: "测试群",
        summary: "当前群 测试群 (123456)，成员 42"
      },
      expectedLocator: "info",
      expectedHint: /view_current_group_info/
    },
    {
      name: "list_current_group_announcements",
      content: {
        ok: true,
        groupId: "123456",
        query: "维护",
        limit: 10,
        count: 1,
        summary: "当前群 123456 公告查询返回 1/1 条，limit=10，query=\"维护\"",
        items: [{ id: "n1", title: "维护通知", content: "今晚维护" }]
      },
      expectedLocator: "announcements query=\"维护\" limit=10",
      expectedHint: /list_current_group_announcements query=\\"维护\\" limit=10/
    },
    {
      name: "list_current_group_members",
      content: {
        ok: true,
        groupId: "123456",
        query: "Alice",
        limit: 20,
        count: 1,
        summary: "当前群 123456 成员查询返回 1/1 人，limit=20，query=\"Alice\"",
        items: [{ userId: "10001", displayName: "Alice" }]
      },
      expectedLocator: "members query=\"Alice\" limit=20",
      expectedHint: /list_current_group_members query=\\"Alice\\" limit=20/
    }
  ];

  for (const tool of tools) {
    const observation = buildToolObservation({
      toolName: tool.name,
      toolCallId: `call-${tool.name}`,
      content: JSON.stringify(tool.content)
    });

    assert.equal(observation.retention, "summary");
    assert.equal(observation.resource?.kind, "external");
    assert.equal(observation.resource?.id, "onebot:group:123456");
    assert.equal(observation.resource?.locator, tool.expectedLocator);
    assert.equal(observation.refetchable, true);
    assert.match(observation.replayContent, /"compacted":true/);
    assert.match(observation.replayContent, tool.expectedHint);
  }
});

test("tool_result transcript schema accepts optional observation metadata", () => {
  const observation = buildToolObservation({
    toolName: "terminal_run",
    toolCallId: "call_shell_1",
    content: JSON.stringify({
      stdout: "ok\n".repeat(100),
      stderr: "",
      exitCode: 0
    })
  });

  const parsed = internalTranscriptItemSchema.parse({
    kind: "tool_result",
    llmVisible: true,
    timestampMs: 1,
    toolCallId: "call_shell_1",
    toolName: "terminal_run",
    content: JSON.stringify({ stdout: "ok\n".repeat(100), stderr: "", exitCode: 0 }),
    observation
  });

  assert.equal(parsed.kind, "tool_result");
  assert.equal(parsed.observation?.resource?.kind, "shell_session");
  assert.equal(parsed.observation?.retention, "summary");
});

test("compression snapshot and summary prompt include compacted tool observations", () => {
  const observation = buildToolObservation({
    toolName: "local_file_read",
    toolCallId: "tool-1",
    content: JSON.stringify({
      path: "src/conversation/session/sessionTranscript.ts",
      content: "旧工具读取内容\n".repeat(120),
      startLine: 180,
      endLine: 240,
      totalLines: 360,
      truncated: true
    })
  });
  const transcript: InternalTranscriptItem[] = [
    createHistoryMessage("user", "old user", 1),
    {
      kind: "assistant_tool_call",
      llmVisible: true,
      timestampMs: 2,
      content: "",
      toolCalls: [{
        id: "tool-1",
        type: "function",
        function: {
          name: "local_file_read",
          arguments: "{\"path\":\"src/conversation/session/sessionTranscript.ts\"}"
        }
      }]
    } as any,
    {
      kind: "tool_result",
      llmVisible: true,
      timestampMs: 3,
      toolCallId: "tool-1",
      toolName: "local_file_read",
      content: JSON.stringify({ path: "src/conversation/session/sessionTranscript.ts", content: "旧工具读取内容" }),
      observation
    },
    createHistoryMessage("assistant", "old assistant", 4),
    createHistoryMessage("user", "new user", 5),
    createHistoryMessage("assistant", "new assistant", 6)
  ];

  const snapshot = projectCompressionHistorySnapshot({
    historySummary: null,
    internalTranscript: transcript
  } as any, createTestAppConfig(), 0, 2);

  assert.ok(snapshot);
  assert.equal(snapshot.toolObservationsToCompress.length, 1);
  assert.match(snapshot.toolObservationsToCompress[0]?.summary ?? "", /sessionTranscript\.ts/);

  const prompt = buildHistorySummaryPrompt({
    sessionId: "qqbot:p:test",
    existingSummary: null,
    messagesToCompress: snapshot.messagesToCompress,
    toolObservationsToCompress: snapshot.toolObservationsToCompress
  });

  assert.match(String(prompt[1]?.content ?? ""), /summary_source_tool_observations/);
  assert.match(String(prompt[1]?.content ?? ""), /local_file_read/);
  assert.match(String(prompt[1]?.content ?? ""), /sessionTranscript\.ts/);
});

test("derived observation adapters expose tool, image, and audio observations without persistence migration", () => {
  const observation = buildToolObservation({
    toolName: "local_file_read",
    toolCallId: "tool-1",
    content: JSON.stringify({
      path: "src/conversation/session/toolObservation.ts",
      content: "工具内容",
      startLine: 1,
      endLine: 20
    })
  });

  assert.deepEqual(toolObservationToDerivedObservation("tool-1", observation), {
    sourceKind: "tool_result",
    sourceId: "tool-1",
    purpose: "tool_replay_compaction",
    status: "ready",
    text: observation.summary,
    sourceHash: observation.contentHash
  });

  assert.deepEqual(imageCaptionToDerivedObservation("file_1", "  一张猫图  "), {
    sourceKind: "chat_file",
    sourceId: "file_1",
    purpose: "image_caption",
    status: "ready",
    text: "一张猫图"
  });

  assert.deepEqual(audioTranscriptionToDerivedObservation({
    id: "aud_1",
    source: "https://example.com/a.mp3",
    createdAt: 1,
    transcription: "你好",
    transcriptionStatus: "ready",
    transcriptionUpdatedAt: 2,
    transcriptionModelRef: "audio-model",
    transcriptionError: null
  }), {
    sourceKind: "audio",
    sourceId: "aud_1",
    purpose: "audio_transcription",
    status: "ready",
    text: "你好",
    modelRef: "audio-model",
    updatedAt: 2,
    error: null
  });
});

function createHistoryMessage(role: "user" | "assistant", text: string, timestampMs: number): InternalTranscriptItem {
  if (role === "user") {
    return {
      kind: "user_message",
      role,
      llmVisible: true,
      chatType: "private",
      userId: "10001",
      senderName: "Alice",
      text,
      imageIds: [],
      emojiIds: [],
      attachments: [],
      audioCount: 0,
      forwardIds: [],
      replyMessageId: null,
      mentionUserIds: [],
      mentionedAll: false,
      mentionedSelf: false,
      timestampMs
    };
  }
  return {
    kind: "assistant_message",
    role,
    llmVisible: true,
    chatType: "private",
    userId: "bot",
    senderName: "Bot",
    text,
    timestampMs
  };
}
