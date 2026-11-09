import test from "node:test";
import assert from "node:assert/strict";
import { createTestAppConfig } from "../helpers/config-fixtures.tsx";
import { selectRequestContext, withProjectedRequestHistory } from "../../src/conversation/session/requestContextSelection.ts";
import { projectLlmVisibleHistoryFromTranscript } from "../../src/conversation/session/sessionTranscript.ts";
import { getProviderTranscriptProjector } from "../../src/app/generation/providerTranscriptProjector.ts";
import { collectReferencedImageIds } from "../../src/images/imagePromptContext.ts";
import { formatStructuredImageReference } from "../../src/conversation/session/historyContext.ts";
import type { InternalTranscriptItem } from "../../src/conversation/session/sessionTypes.ts";

function config(maxRecentMessages = 80, maxImageReferences = 5) {
  return createTestAppConfig({ llm: { routingPresets: { test: { historyWindow: { maxRecentMessages, maxImageReferences } } } } });
}

function user(index: number): Extract<InternalTranscriptItem, { kind: "user_message" }> {
  return {
    kind: "user_message", id: `u-${index}`, role: "user", llmVisible: true, chatType: "private",
    userId: "synthetic", senderName: "合成测试", text: `合成消息 ${index}`, imageIds: [`image-${index}`],
    emojiIds: [], attachments: [], messageFiles: [], audioCount: 0, forwardIds: [], replyMessageId: null,
    mentionUserIds: [], mentionedAll: false, mentionedSelf: false, timestampMs: index
  };
}

function assistant(index: number, extra: Partial<Extract<InternalTranscriptItem, { kind: "assistant_message" }>> = {}): Extract<InternalTranscriptItem, { kind: "assistant_message" }> {
  return { kind: "assistant_message", id: `a-${index}`, role: "assistant", llmVisible: true, chatType: "private",
    userId: "bot", senderName: "助手", text: `合成回复 ${index}`, timestampMs: index, ...extra };
}

function replay(transcript: InternalTranscriptItem[], providerName = "openai", maxRecentMessages = 80, maxImageReferences = 5) {
  const selection = selectRequestContext(transcript, config(maxRecentMessages, maxImageReferences));
  return { selection, projection: getProviderTranscriptProjector(providerName).project({ transcript: selection.transcript,
    projectedContent: selection.contentByItem, invalidatedNativeItems: selection.invalidatedNativeItems, preserveThinking: true }) };
}

for (const provider of ["openai", "openai_compatible", "anthropic", "google", "vertex"]) {
  test(`${provider} native replay shares the 80 message / 5 image request window`, () => {
    const transcript = Array.from({ length: 200 }, (_, i) => user(i));
    const before = JSON.stringify(transcript);
    const { selection, projection } = replay(transcript, provider);
    const history = projectLlmVisibleHistoryFromTranscript(transcript, config());
    assert.equal(history.length, 80);
    assert.equal(selection.history.length, 80);
    assert.equal(projection.replayMessages.length, 80);
    assert.deepEqual(projection.replayMessages.map(item => item.content), history.map(item => item.content));
    assert.deepEqual(collectReferencedImageIds(projection.replayMessages as Array<{ content: string }>),
      [195, 196, 197, 198, 199].map(i => `image-${i}`));
    assert.equal(projection.replayCoversVisibleHistory, true);
    assert.equal(JSON.stringify(transcript), before);
  });
}

test("zero historical image budget and latest references within one message are consistent", () => {
  const item = user(0);
  item.imageIds = ["first", "second", "last"];
  assert.deepEqual(collectReferencedImageIds(replay([item], "openai", 1, 1).selection.history), ["last"]);
  assert.deepEqual(collectReferencedImageIds(replay([item], "openai", 1, 0).projection.replayMessages as Array<{ content: string }>), []);
});

test("tools and visible history share image allowance without reviving old exchanges", () => {
  const call: InternalTranscriptItem = { kind: "assistant_tool_call", llmVisible: true, timestampMs: 1, content: "",
    toolCalls: [{ id: "call", type: "function", function: { name: "image_tool", arguments: "{}" } }] };
  const result: InternalTranscriptItem = { kind: "tool_result", llmVisible: true, timestampMs: 2,
    toolCallId: "call", toolName: "image_tool", content: formatStructuredImageReference("tool-image") };
  const transcript = [user(0), call, result, assistant(3), user(4)];
  const { projection } = replay(transcript, "openai", 3, 1);
  assert.deepEqual(collectReferencedImageIds(projection.replayMessages as Array<{ content: string }>), ["image-4"]);
  assert.equal(projection.replayMessages.filter(item => item.role === "tool").length, 1);
  const clipped = replay(transcript, "openai", 2, 1).projection;
  assert.equal(clipped.replayMessages.some(item => item.tool_calls?.length || item.role === "tool"), false);
});

test("safe request history cannot be replaced with unfiltered replay text", () => {
  const selection = selectRequestContext([user(1)], config());
  const safe = withProjectedRequestHistory(selection, [{ content: "已过滤" }]);
  const projected = getProviderTranscriptProjector("openai").project({ transcript: safe.transcript,
    projectedContent: safe.contentByItem, preserveThinking: true });
  assert.equal(projected.replayMessages[0]?.content, "已过滤");
  assert.deepEqual(collectReferencedImageIds(projected.replayMessages as Array<{ content: string }>), []);
});

test("unmodified native reasoning stays intact, changed content invalidates overriding payloads", () => {
  const metadata = { anthropicContentBlocks: [{ type: "text", text: "原文" }], openAiResponses: { outputItems: [{ type: "message" }] } };
  const item = assistant(1, { reasoningContent: "原生思考", providerMetadata: metadata });
  const { selection, projection } = replay([item]);
  assert.equal(projection.replayMessages[0]?.reasoning_content, "原生思考");
  assert.deepEqual(projection.replayMessages[0]?.providerMetadata, metadata);
  const safe = withProjectedRequestHistory(selection, [{ content: "安全投影" }]);
  const changed = getProviderTranscriptProjector("openai").project({ transcript: safe.transcript,
    projectedContent: safe.contentByItem, preserveThinking: true });
  assert.equal(changed.replayMessages[0]?.content, "安全投影");
  assert.equal(changed.replayMessages[0]?.providerMetadata?.anthropicContentBlocks, undefined);
  assert.equal(changed.replayMessages[0]?.providerMetadata?.openAiResponses, undefined);
});

test("a native response carrier loses its raw payload when an earlier source fragment is outside the window", () => {
  const first = assistant(1, { groupId: "response" });
  const carrier = assistant(2, { groupId: "response", providerMetadata: { googleParts: [{ text: "两段原始响应" }],
    openAiResponses: { outputItems: [{ type: "message" }] } } });
  const { projection } = replay([first, carrier], "google", 1);
  assert.equal(projection.replayMessages.length, 1);
  assert.equal(projection.replayMessages[0]?.providerMetadata?.googleParts, undefined);
  assert.equal(projection.replayMessages[0]?.providerMetadata?.openAiResponses, undefined);
  assert.equal(projection.replayMessages[0]?.providerMetadata?.googleReplayInvalidated, true);
});

test("Google skips incomplete parallel tool exchanges while preserving a complete signed exchange", () => {
  const call: InternalTranscriptItem = { kind: "assistant_tool_call", llmVisible: true, timestampMs: 2, content: "",
    providerMetadata: { googleParts: [{ thoughtSignature: "signature", functionCall: { name: "tool_a", args: {} } }] },
    toolCalls: ["a", "b"].map(id => ({ id, type: "function", function: { name: `tool_${id}`, arguments: "{}" } })) };
  const result = (id: string): InternalTranscriptItem => ({ kind: "tool_result", llmVisible: true,
    timestampMs: 3, toolCallId: id, toolName: `tool_${id}`, content: "完成" });
  const incomplete = replay([user(1), call, result("a")], "google").projection;
  assert.equal(incomplete.replayMessages.some(item => item.tool_calls?.length || item.role === "tool"), false);
  const complete = replay([user(1), call, result("a"), result("b")], "google").projection;
  assert.deepEqual(complete.replayMessages.map(item => item.role), ["user", "assistant", "tool", "tool"]);
  assert.deepEqual(complete.replayMessages[1]?.providerMetadata, call.providerMetadata);
});

test("mode and profile transitions remain visible in Google native history", () => {
  const mode: InternalTranscriptItem = { kind: "session_mode_switch", role: "assistant", llmVisible: true,
    timestampMs: 2, fromModeId: "assistant", toModeId: "rp_assistant", content: "模式已切换" };
  const profile: InternalTranscriptItem = { kind: "profile_phase_transition", role: "assistant", llmVisible: true,
    timestampMs: 3, target: "persona", phase: "config", action: "enter", source: "command", content: "开始配置" };
  const { selection, projection } = replay([user(1), mode, profile], "google");
  assert.deepEqual(projection.replayMessages.map(item => item.content), selection.history.map(item => item.content));
});

test("changing one selected source fragment invalidates the whole native response carrier", () => {
  const first = assistant(1, { groupId: "response", text: "原始第一段" });
  const carrier = assistant(2, { groupId: "response", providerMetadata: { googleParts: [{ text: "原始完整响应", thoughtSignature: "sig" }] } });
  const selected = selectRequestContext([first, carrier], config(2, 0));
  const safe = withProjectedRequestHistory(selected, [{ content: "安全替换的第一段" }, selected.history[1]!]);
  const projection = getProviderTranscriptProjector("google").project({ transcript: safe.transcript,
    projectedContent: safe.contentByItem, invalidatedNativeItems: safe.invalidatedNativeItems, preserveThinking: true });
  assert.equal(projection.replayMessages.length, 2);
  assert.equal(projection.replayMessages[1]?.providerMetadata?.googleParts, undefined);
  assert.deepEqual(collectReferencedImageIds(projection.replayMessages as Array<{ content: string }>), []);
});

test("duplicate tool call identities never form a valid replay exchange", () => {
  const call: InternalTranscriptItem = { kind: "assistant_tool_call", llmVisible: true, timestampMs: 2, content: "",
    toolCalls: ["first", "second"].map(name => ({ id: "duplicate", type: "function", function: { name, arguments: "{}" } })) };
  const result: InternalTranscriptItem = { kind: "tool_result", llmVisible: true, timestampMs: 3,
    toolCallId: "duplicate", toolName: "first", content: "完成" };
  const { projection } = replay([user(1), call, result]);
  assert.deepEqual(projection.replayMessages.map(item => item.role), ["user"]);
});
