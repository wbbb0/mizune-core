import test from "node:test";
import assert from "node:assert/strict";
import { getProviderTranscriptProjector } from "../../src/app/generation/providerTranscriptProjector.ts";
import type { InternalTranscriptItem } from "../../src/conversation/session/sessionTypes.ts";

  const transcript: InternalTranscriptItem[] = [
    {
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
      }]
    },
    {
      kind: "tool_result",
      llmVisible: true,
      timestampMs: 2,
      toolCallId: "call_openai_1",
      toolName: "shell_run",
      content: "{\"stdout\":\"/repo\"}"
    }
  ];

  test("dashscope projector replays assistant tool calls and tool results", () => {
    const projection = getProviderTranscriptProjector("dashscope").project({ transcript });
    assert.equal(projection.replayMessages.length, 2);
    assert.equal(projection.replayMessages[0]?.role, "assistant");
    assert.equal(projection.replayMessages[1]?.role, "tool");
    assert.deepEqual(projection.lateSystemMessages, []);
  });

  test("dashscope projector replays visible history with assistant reasoning when preserveThinking is enabled", () => {
    const projection = getProviderTranscriptProjector("dashscope").project({
      transcript: [
        {
          kind: "user_message",
          role: "user",
          llmVisible: true,
          chatType: "private",
          userId: "10001",
          senderName: "Alice",
          text: "继续",
          imageIds: [],
          emojiIds: [],
          attachments: [],
          audioCount: 0,
          forwardIds: [],
          replyMessageId: null,
          mentionUserIds: [],
          mentionedAll: false,
          mentionedSelf: false,
          timestampMs: 1
        },
        {
          kind: "assistant_message",
          role: "assistant",
          llmVisible: true,
          chatType: "private",
          userId: "bot",
          senderName: "Bot",
          text: "上一轮答复",
          timestampMs: 2,
          reasoningContent: "previous reasoning"
        },
        {
          kind: "assistant_tool_call",
          llmVisible: true,
          timestampMs: 3,
          content: "",
          toolCalls: [{
            id: "call_dashscope_1",
            type: "function",
            function: {
              name: "shell_run",
              arguments: "{\"cmd\":\"pwd\"}"
            }
          }]
        },
        {
          kind: "tool_result",
          llmVisible: true,
          timestampMs: 4,
          toolCallId: "call_dashscope_1",
          toolName: "shell_run",
          content: "{\"stdout\":\"/repo\"}"
        }
      ],
      preserveThinking: true
    });

    assert.equal(projection.replayCoversVisibleHistory, true);
    assert.equal(projection.replayMessages[0]?.role, "user");
    assert.equal(projection.replayMessages[1]?.role, "assistant");
    assert.equal(projection.replayMessages[1]?.reasoning_content, "previous reasoning");
    assert.equal(projection.replayMessages[2]?.role, "assistant");
    assert.equal(projection.replayMessages[3]?.role, "tool");
  });

  test("gemini projector silently skips tool calls without google replay metadata", () => {
    const projection = getProviderTranscriptProjector("google").project({ transcript });
    assert.equal(projection.replayMessages.length, 0);
    assert.equal(projection.replayCoversVisibleHistory, false);
    assert.deepEqual(projection.lateSystemMessages, []);
  });

  test("gemini projector drops leading replayable tool chains without a preceding user turn", () => {
    const projection = getProviderTranscriptProjector("google").project({
      transcript: [
        {
          kind: "assistant_tool_call",
          llmVisible: true,
          timestampMs: 1,
          content: "",
          toolCalls: [{
            id: "call_google_leading_1",
            type: "function",
            function: {
              name: "view_media",
              arguments: "{\"id\":\"asset_1\"}"
            },
            providerMetadata: {
              google: {
                thoughtSignature: "sig-leading-1"
              }
            }
          }],
          providerMetadata: {
            googleParts: [{
              thoughtSignature: "sig-leading-1",
              functionCall: {
                id: "call_google_leading_1",
                name: "view_media",
                args: { id: "asset_1" }
              }
            }]
          }
        },
        {
          kind: "tool_result",
          llmVisible: true,
          timestampMs: 2,
          toolCallId: "call_google_leading_1",
          toolName: "view_media",
          content: "{\"ok\":true}"
        },
        {
          kind: "user_message",
          role: "user",
          llmVisible: true,
          chatType: "private",
          userId: "10001",
          senderName: "Alice",
          text: "继续",
          imageIds: [],
          emojiIds: [],
          attachments: [],
          audioCount: 0,
          forwardIds: [],
          replyMessageId: null,
          mentionUserIds: [],
          mentionedAll: false,
          mentionedSelf: false,
          timestampMs: 3
        }
      ]
    });

    assert.deepEqual(
      projection.replayMessages.map((message) => message.role),
      ["user"]
    );
  });

  test("gemini projector replays tool calls when google thought signatures exist and a user turn precedes them", () => {
    const projection = getProviderTranscriptProjector("google").project({
      transcript: [
        {
          kind: "user_message",
          role: "user",
          llmVisible: true,
          chatType: "private",
          userId: "10001",
          senderName: "Alice",
          text: "查一下",
          imageIds: [],
          emojiIds: [],
          attachments: [],
          audioCount: 0,
          forwardIds: [],
          replyMessageId: null,
          mentionUserIds: [],
          mentionedAll: false,
          mentionedSelf: false,
          timestampMs: 1
        },
        {
          kind: "assistant_tool_call",
          llmVisible: true,
          timestampMs: 2,
          content: "",
          toolCalls: [{
            id: "call_google_1",
            type: "function",
            function: {
              name: "open_page",
              arguments: "{\"url\":\"https://example.com\"}"
            },
            providerMetadata: {
              google: {
                thoughtSignature: "sig-1"
              }
            }
          }]
        }
      ]
    });

    assert.equal(projection.replayMessages.length, 2);
    assert.equal(projection.replayMessages[1]?.role, "assistant");
    assert.equal(projection.replayCoversVisibleHistory, true);
    assert.deepEqual(projection.lateSystemMessages, []);
  });

  test("gemini projector replays tool calls when assistant googleParts are persisted after a user turn", () => {
    const projection = getProviderTranscriptProjector("google").project({
      transcript: [
        {
          kind: "user_message",
          role: "user",
          llmVisible: true,
          chatType: "private",
          userId: "10001",
          senderName: "Alice",
          text: "继续",
          imageIds: [],
          emojiIds: [],
          attachments: [],
          audioCount: 0,
          forwardIds: [],
          replyMessageId: null,
          mentionUserIds: [],
          mentionedAll: false,
          mentionedSelf: false,
          timestampMs: 1
        },
        {
          kind: "assistant_tool_call",
          llmVisible: true,
          timestampMs: 2,
          content: "",
          toolCalls: [{
            id: "call_google_2",
            type: "function",
            function: {
              name: "get_persona",
              arguments: "{}"
            }
          }],
          providerMetadata: {
            googleParts: [{
              thoughtSignature: "sig-2",
              functionCall: {
                id: "call_google_2",
                name: "get_persona",
                args: {}
              }
            }]
          }
        }
      ]
    });

    assert.equal(projection.replayMessages.length, 2);
    assert.equal(projection.replayMessages[1]?.role, "assistant");
    assert.equal(projection.replayCoversVisibleHistory, true);
    assert.deepEqual(projection.lateSystemMessages, []);
  });

  test("gemini projector silently skips assistant googleParts without thought signatures", () => {
    const projection = getProviderTranscriptProjector("google").project({
      transcript: [{
        kind: "assistant_tool_call",
        llmVisible: true,
        timestampMs: 1,
        content: "",
        toolCalls: [{
          id: "call_google_2b",
          type: "function",
          function: {
            name: "get_persona",
            arguments: "{}"
          }
        }],
        providerMetadata: {
          googleParts: [{
            functionCall: {
              id: "call_google_2b",
              name: "get_persona",
              args: {}
            }
          }]
        }
      }]
    });

    assert.equal(projection.replayMessages.length, 0);
    assert.deepEqual(projection.lateSystemMessages, []);
  });

  test("gemini projector preserves visible-message chronology for replayable transcript", () => {
    const projection = getProviderTranscriptProjector("google").project({
      transcript: [
        {
          kind: "user_message",
          role: "user",
          llmVisible: true,
          chatType: "private",
          userId: "10001",
          senderName: "Alice",
          text: "先查一下",
          imageIds: [],
          emojiIds: [],
          attachments: [],
          audioCount: 0,
          forwardIds: [],
          replyMessageId: null,
          mentionUserIds: [],
          mentionedAll: false,
          mentionedSelf: false,
          timestampMs: 1
        },
        {
          kind: "assistant_tool_call",
          llmVisible: true,
          timestampMs: 2,
          content: "",
          toolCalls: [{
            id: "call_google_3",
            type: "function",
            function: {
              name: "get_persona",
              arguments: "{}"
            }
          }],
          providerMetadata: {
            googleParts: [{
            thoughtSignature: "sig-3",
            functionCall: {
              id: "call_google_3",
              name: "get_persona",
              args: {}
            }
          }]
        }
        },
        {
          kind: "tool_result",
          llmVisible: true,
          timestampMs: 3,
          toolCallId: "call_google_3",
          toolName: "get_persona",
          content: "{\"ok\":true}"
        },
        {
          kind: "assistant_message",
          role: "assistant",
          llmVisible: true,
          chatType: "private",
          userId: "10001",
          senderName: "Alice",
          text: "查到了",
          timestampMs: 4
        }
      ]
    });

    assert.deepEqual(
      projection.replayMessages.map((message) => message.role),
      ["user", "assistant", "tool", "assistant"]
    );
    assert.equal(projection.replayCoversVisibleHistory, true);
    assert.deepEqual(projection.lateSystemMessages, []);
  });

  test("gemini projector silently skips foreign-provider tool calls while preserving visible messages", () => {
    const projection = getProviderTranscriptProjector("google").project({
      transcript: [
        {
          kind: "user_message",
          role: "user",
          llmVisible: true,
          chatType: "private",
          userId: "10001",
          senderName: "Alice",
          text: "帮我查一下天气",
          imageIds: [],
          emojiIds: [],
          attachments: [],
          audioCount: 0,
          forwardIds: [],
          replyMessageId: null,
          mentionUserIds: [],
          mentionedAll: false,
          mentionedSelf: false,
          timestampMs: 1
        },
        {
          kind: "assistant_tool_call",
          llmVisible: true,
          timestampMs: 2,
          content: "",
          toolCalls: [{
            id: "call_foreign_1",
            type: "function",
            function: {
              name: "lookup_weather",
              arguments: "{\"city\":\"Shanghai\"}"
            }
          }]
        },
        {
          kind: "tool_result",
          llmVisible: true,
          timestampMs: 3,
          toolCallId: "call_foreign_1",
          toolName: "lookup_weather",
          content: "{\"temp\":22}"
        },
        {
          kind: "assistant_message",
          role: "assistant",
          llmVisible: true,
          chatType: "private",
          userId: "10001",
          senderName: "Alice",
          text: "今天 22 度。",
          timestampMs: 4
        }
      ]
    });

    assert.deepEqual(
      projection.replayMessages.map((message) => message.role),
      ["user", "assistant"]
    );
    assert.equal(projection.replayCoversVisibleHistory, true);
    assert.deepEqual(projection.lateSystemMessages, []);
  });

  test("gemini projector skips tool calls that appear right after an assistant visible message", () => {
    const projection = getProviderTranscriptProjector("google").project({
      transcript: [
        {
          kind: "user_message",
          role: "user",
          llmVisible: true,
          chatType: "private",
          userId: "10001",
          senderName: "Alice",
          text: "先总结一下",
          imageIds: [],
          emojiIds: [],
          attachments: [],
          audioCount: 0,
          forwardIds: [],
          replyMessageId: null,
          mentionUserIds: [],
          mentionedAll: false,
          mentionedSelf: false,
          timestampMs: 1
        },
        {
          kind: "assistant_message",
          role: "assistant",
          llmVisible: true,
          chatType: "private",
          userId: "10001",
          senderName: "Alice",
          text: "先前结果如下。",
          timestampMs: 2
        },
        {
          kind: "assistant_tool_call",
          llmVisible: true,
          timestampMs: 3,
          content: "",
          toolCalls: [{
            id: "call_google_after_assistant_1",
            type: "function",
            function: {
              name: "lookup",
              arguments: "{\"q\":\"test\"}"
            },
            providerMetadata: {
              google: {
                thoughtSignature: "sig-after-assistant-1"
              }
            }
          }],
          providerMetadata: {
            googleParts: [{
              thoughtSignature: "sig-after-assistant-1",
              functionCall: {
                id: "call_google_after_assistant_1",
                name: "lookup",
                args: { q: "test" }
              }
            }]
          }
        },
        {
          kind: "tool_result",
          llmVisible: true,
          timestampMs: 4,
          toolCallId: "call_google_after_assistant_1",
          toolName: "lookup",
          content: "{\"ok\":true}"
        }
      ]
    });

    assert.deepEqual(
      projection.replayMessages.map((message) => message.role),
      ["user", "assistant"]
    );
  });
